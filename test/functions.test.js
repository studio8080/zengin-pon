// node test/functions.test.js — Webhook とキー更新の全経路を、Stripe・Firestore・メールを差し替えて確かめる
// （functions の npm install は不要。外部モジュールはすべて差し替える。functions/node_modules に stripe があれば、
//   署名の検証だけは本物の SDK でも確かめる）
//
// イベントは Stripe の実際の形（Webhook の API バージョン 2026-08-26.dahlia、SDK の照会は 2025-08-27.basil）に合わせ、
// 使わない項目も入れた本物らしい JSON にしている。古い形（basil より前: 直下の current_period_end、invoice.subscription、
// 明細の price.product）と、2026-10-15 より前に作られた Firestore の記録（stripeCheckedAt が無い・イベントの記録が無い）でも
// 動くことを別に確かめる。有休ポンの functions/test/functions.test.js と同じ作り。
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');

const FN = path.join(__dirname, '..', 'functions');
const ZP = 'prod_VEa5100IEJu6JE'; // 全銀ポン Pro
const YUKYU = 'prod_TEST_YUKYU'; // 共用アカウントのほかの製品
const MISEFITS = 'prod_MISEFITS_TEST';
const WHSEC = 'whsec_test_secret';
const API_VERSION = '2026-08-26.dahlia';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); // 使い捨ての鍵（本番の秘密鍵は使わない）
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// ---- 差し替え ----
const store = {}; // Firestore の代わり（コレクション/ID → 値）
const mails = [];
let subs = {};
let customers = {};
let failMailOnce = false;
let smtpHost = 'smtp.example';
const calls = { subRetrieve: 0, custRetrieve: 0 };
let subRetrieveError = null; // Stripe 照会の失敗（権限不足など）
const setFailures = []; // Firestore の set を1回失敗させる条件
let realWebhooks = null; // 本物の SDK の webhooks（あれば）

const docRef = (col, id) => {
  const k = `${col}/${id}`;
  return {
    async set(v, o) {
      const i = setFailures.findIndex((f) => f(k, v));
      if (i >= 0) {
        setFailures.splice(i, 1);
        throw new Error('14 UNAVAILABLE: firestore down');
      }
      store[k] = o && o.merge ? { ...(store[k] || {}), ...v } : { ...v };
    },
    async create(v) {
      if (store[k]) {
        const e = new Error('6 ALREADY_EXISTS: Document already exists');
        e.code = 6;
        throw e;
      }
      store[k] = { ...v };
    },
    async get() {
      return { exists: !!store[k], data: () => store[k] };
    },
  };
};
const tick = () => new Promise((r) => setTimeout(r, 2));
const stripeError = (type, message, extra = {}) => Object.assign(new Error(message), { type, ...extra });

const fakes = {
  'firebase-functions/v2/https': { onRequest: (_opts, fn) => Object.assign(fn, { opts: _opts }) },
  'firebase-functions/params': {
    defineSecret: (n) => ({ value: () => ({ ZP_LICENSE_PRIVATE_KEY: PEM, MAIL_FROM: 'MiseFits <studio@kokokikaku.com>', ZP_STRIPE_WEBHOOK_SECRET: WHSEC })[n] || 'x' }),
    defineString: (n, o) => ({ value: () => (n === 'SMTP_HOST' ? smtpHost : (o && o.default) || '') }),
  },
  'firebase-admin/app': { initializeApp() {}, getApps: () => [1] },
  'firebase-admin/firestore': { getFirestore: () => ({ collection: (col) => ({ doc: (id) => docRef(col, id) }) }) },
  stripe: function Stripe() {
    return {
      webhooks: {
        // Stripe の署名方式（t=<時刻>,v1=<HMAC-SHA256(t.本文)>）をそのまま再現する
        constructEvent: (raw, header, secret) => {
          if (realWebhooks) return realWebhooks.constructEvent(raw, header, secret);
          const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')));
          const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
          if (!parts.v1 || parts.v1 !== expected) throw stripeError('StripeSignatureVerificationError', 'No signatures found matching the expected signature for payload');
          return JSON.parse(raw.toString());
        },
      },
      subscriptions: {
        retrieve: async (id) => {
          calls.subRetrieve++;
          await tick();
          if (subRetrieveError) throw subRetrieveError;
          if (!subs[id]) throw stripeError('StripeInvalidRequestError', `No such subscription: '${id}'`, { code: 'resource_missing', statusCode: 404 });
          return JSON.parse(JSON.stringify(subs[id]));
        },
      },
      customers: {
        retrieve: async (id) => {
          calls.custRetrieve++;
          const c = customers[id];
          if (c instanceof Error) throw c;
          if (!c) throw stripeError('StripeInvalidRequestError', `No such customer: '${id}'`, { code: 'resource_missing', statusCode: 404 });
          return c;
        },
      },
    };
  },
  nodemailer: {
    createTransport: () => ({
      sendMail: async (m) => {
        if (failMailOnce) {
          failMailOnce = false;
          throw new Error('SMTP down');
        }
        mails.push(m);
      },
    }),
  },
};
const sign = require(path.join(FN, 'sign.js'));
const B = require(path.join(FN, 'billing.js'));
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return fakes[req] || origLoad.call(this, req, ...rest);
};
const fns = require(path.join(FN, 'index.js'));
Module._load = origLoad;

// ---- 日付 ----
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
const plusDays = (n) => isoDay(now + n * DAY);

// ---- Stripe の実際の形に近いオブジェクト ----
let seq = 0;
const rid = (p) => `${p}_${(++seq).toString(36).padStart(14, '0')}`;
const priceOf = (product, interval, amount) => ({
  id: `price_${product}_${interval}`,
  object: 'price',
  active: true,
  billing_scheme: 'per_unit',
  created: now - 30 * DAY,
  currency: 'jpy',
  custom_unit_amount: null,
  livemode: true,
  lookup_key: null,
  metadata: {},
  nickname: null,
  product, // サブスクリプションの中では商品は文字列のID（展開しない）
  recurring: { interval, interval_count: 1, meter: null, trial_period_days: null, usage_type: 'licensed' },
  tax_behavior: 'inclusive',
  tiers_mode: null,
  transform_quantity: null,
  type: 'recurring',
  unit_amount: amount,
  unit_amount_decimal: String(amount),
});

/** サブスクリプション（2026-08-26.dahlia の形）。legacy: true なら basil より前の形（期間が直下） */
function mkSub(id, product, o = {}) {
  const interval = o.interval || 'month';
  const start = o.start != null ? o.start : now - 2 * DAY;
  const end = o.end != null ? o.end : start + (interval === 'year' ? 365 : 30) * DAY;
  const amount = interval === 'year' ? 4800 : 480;
  const item = {
    id: `si_${id}`,
    object: 'subscription_item',
    billing_thresholds: null,
    created: start,
    current_period_end: end,
    current_period_start: start,
    discounts: [],
    metadata: {},
    plan: { id: `price_${product}_${interval}`, object: 'plan', active: true, amount, currency: 'jpy', interval, interval_count: 1, product, usage_type: 'licensed' },
    price: priceOf(product, interval, amount),
    quantity: 1,
    subscription: id,
    tax_rates: [],
  };
  if (o.legacy) {
    delete item.current_period_end;
    delete item.current_period_start;
  }
  return {
    id,
    object: 'subscription',
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null },
    billing_cycle_anchor: start,
    billing_cycle_anchor_config: null,
    billing_mode: { type: 'flexible', flexible: { proration_discounts: 'included' }, updated_at: start },
    billing_thresholds: null,
    cancel_at: o.cancel_at || null,
    cancel_at_period_end: !!o.cancel_at_period_end,
    canceled_at: o.canceled_at || null,
    cancellation_details: { comment: null, feedback: null, reason: o.status === 'canceled' ? 'cancellation_requested' : null },
    collection_method: 'charge_automatically',
    created: start,
    currency: 'jpy',
    customer: o.customer || `cus_${id}`,
    customer_account: null,
    days_until_due: null,
    default_payment_method: 'pm_1Test',
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    ended_at: o.ended_at || null,
    invoice_settings: { account_tax_ids: null, issuer: { type: 'self' } },
    items: { object: 'list', data: [item], has_more: false, total_count: 1, url: `/v1/subscription_items?subscription=${id}` },
    latest_invoice: `in_${id}`,
    livemode: true,
    metadata: {},
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: { payment_method_options: null, payment_method_types: null, save_default_payment_method: 'off' },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    plan: null,
    quantity: 1,
    schedule: null,
    start_date: start,
    status: o.status || 'active',
    test_clock: null,
    transfer_data: null,
    trial_end: null,
    trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
    trial_start: null,
    ...(o.legacy ? { current_period_start: start, current_period_end: end } : {}),
  };
}

/** 支払いリンク（Payment Link）から完了したチェックアウト */
function mkSession(subId, o = {}) {
  return {
    id: rid('cs_live'),
    object: 'checkout.session',
    adaptive_pricing: { enabled: false },
    after_expiration: null,
    allow_promotion_codes: false,
    amount_subtotal: o.amount || 480,
    amount_total: o.amount || 480,
    automatic_tax: { enabled: false, liability: null, provider: null, status: null },
    billing_address_collection: 'auto',
    cancel_url: null,
    client_reference_id: null,
    collected_information: { business_name: null, individual_name: null, shipping_details: null },
    consent: null,
    consent_collection: null,
    created: now - 60,
    currency: 'jpy',
    custom_fields: [],
    custom_text: { after_submit: null, shipping_address: null, submit: { message: '月払いは毎月、年払いは毎年、解約するまで自動で更新されます。…' }, terms_of_service_acceptance: null },
    customer: o.customer === undefined ? `cus_${subId}` : o.customer,
    customer_creation: 'always',
    customer_details: o.noDetails
      ? null
      : { address: { city: null, country: 'JP', line1: null, line2: null, postal_code: null, state: null }, business_name: null, email: o.email === undefined ? 'buyer@example.com' : o.email, individual_name: null, name: 'テスト 太郎', phone: null, tax_exempt: 'none', tax_ids: [] },
    customer_email: o.customer_email || null,
    discounts: [],
    expires_at: now + DAY,
    invoice: `in_${subId}`,
    invoice_creation: null,
    livemode: true,
    locale: 'auto',
    metadata: {},
    mode: o.mode || 'subscription',
    origin_context: null,
    payment_intent: null,
    payment_link: 'plink_1TestZenginPon',
    payment_method_collection: 'always',
    payment_method_types: ['card'],
    payment_status: 'paid',
    phone_number_collection: { enabled: false },
    recovered_from: null,
    saved_payment_method_options: null,
    setup_intent: null,
    shipping_address_collection: null,
    status: 'complete',
    submit_type: 'auto',
    subscription: subId,
    success_url: 'https://stripe.com',
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: 'hosted',
    url: null,
    wallet_options: null,
  };
}

/** 支払い済みの請求書（dahlia の形: parent.subscription_details・明細の pricing.price_details）。legacy は古い形 */
function mkInvoice(subId, product, o = {}) {
  const amount = o.amount || 480;
  const line = o.legacy
    ? { id: rid('il'), object: 'line_item', amount, currency: 'jpy', description: '1 × 全銀ポン Pro', period: { start: now, end: now + 30 * DAY }, price: priceOf(product, 'month', amount), plan: { id: 'price_x', product }, proration: false, quantity: 1, subscription: subId, type: 'subscription' }
    : {
        id: rid('il'),
        object: 'line_item',
        amount,
        currency: 'jpy',
        description: '1 × 全銀ポン Pro (at ¥480 / month)',
        discount_amounts: [],
        discountable: true,
        discounts: [],
        invoice: `in_${subId}`,
        livemode: true,
        metadata: {},
        parent: { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { invoice_item: null, proration: false, proration_details: { credited_items: null }, subscription: subId, subscription_item: `si_${subId}` } },
        period: { end: now + 30 * DAY, start: now },
        pretax_credit_amounts: [],
        pricing: { price_details: { price: `price_${product}_month`, product }, type: 'price_details', unit_amount_decimal: String(amount) },
        quantity: 1,
        taxes: [],
      };
  return {
    id: rid('in'),
    object: 'invoice',
    account_country: 'JP',
    account_name: 'ここ企画',
    amount_due: amount,
    amount_paid: amount,
    amount_remaining: 0,
    attempt_count: 1,
    attempted: true,
    billing_reason: o.reason || 'subscription_cycle',
    collection_method: 'charge_automatically',
    created: now,
    currency: 'jpy',
    customer: o.customer || `cus_${subId}`,
    customer_email: o.email === undefined ? 'buyer@example.com' : o.email,
    customer_name: 'テスト 太郎',
    hosted_invoice_url: 'https://invoice.stripe.com/i/test',
    lines: { object: 'list', data: [line], has_more: false, total_count: 1, url: '/v1/invoices/in_x/lines' },
    livemode: true,
    metadata: {},
    number: 'ABCD-0001',
    parent: o.legacy ? null : { quote_details: null, subscription_details: { metadata: {}, subscription: subId }, type: 'subscription_details' },
    ...(o.legacy ? { subscription: subId } : {}),
    period_end: now,
    period_start: now - 30 * DAY,
    status: 'paid',
    status_transitions: { finalized_at: now, marked_uncollectible_at: null, paid_at: now, voided_at: null },
    total: amount,
  };
}

function mkEvent(type, object, o = {}) {
  return {
    id: o.id || rid('evt'),
    object: 'event',
    api_version: API_VERSION,
    created: now,
    data: { object, ...(o.prev ? { previous_attributes: o.prev } : {}) },
    livemode: true,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
  };
}

// ---- 呼び出し ----
function signedHeader(raw, secret = WHSEC) {
  if (realWebhooks) return realWebhooks.generateTestHeaderString({ payload: raw, secret });
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
async function post(event, o = {}) {
  let status = 200, body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, send(b) { body = b; return this; }, set() {} };
  const raw = JSON.stringify(event, null, 2);
  const header = o.header !== undefined ? o.header : signedHeader(raw, o.secret);
  await fns.zenginponStripeWebhook({ method: 'POST', rawBody: Buffer.from(raw), headers: { 'stripe-signature': header, 'content-type': 'application/json' } }, res);
  return { status, body };
}
async function getKey(id, o = {}) {
  let status = 200, body;
  const headers = {};
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, send(b) { body = b; return this; }, set(k, v) { headers[k] = v; } };
  await fns.zenginponLicense({ method: o.method || 'GET', query: { id }, headers: o.origin ? { origin: o.origin } : {} }, res);
  return { status, body, headers };
}
function payloadOf(key) {
  const m = key.match(/^ZP1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  assert.ok(m, 'キーの形式 ZP1-<base64url>.<base64url>');
  const body = Buffer.from(m[1], 'base64url');
  assert.ok(crypto.verify(null, body, publicKey, Buffer.from(m[2], 'base64url')), '署名が正しい');
  return JSON.parse(body.toString());
}
const keyIn = (text) => text.match(/ZP1-\S+/)[0];
const lic = (subId) => store[`zenginponLicenses/${sign.licenseIdFor(subId)}`];
const licenseDocs = () => Object.keys(store).filter((k) => k.startsWith('zenginponLicenses/'));
const eventDocs = () => Object.keys(store).filter((k) => k.startsWith('zenginponEvents/'));
const buy = async (subId, o = {}) => {
  subs[subId] = mkSub(subId, ZP, o);
  return post(mkEvent('checkout.session.completed', mkSession(subId, { email: o.email === undefined ? `${subId}@example.com` : o.email })));
};
const reset = () => {
  mails.length = 0;
  calls.subRetrieve = 0;
  calls.custRetrieve = 0;
};

(async () => {
  let passed = 0;
  const t = async (name, fn) => {
    reset();
    await fn();
    passed++;
    console.log('ok -', name);
  };

  // ---------------- 署名 ----------------
  await t('署名が無い・違う秘密で署名された Webhook は 400 で、何も書かない', async () => {
    const before = Object.keys(store).length;
    subs.sub_S = mkSub('sub_S', ZP);
    const ev = mkEvent('checkout.session.completed', mkSession('sub_S'));
    assert.equal((await post(ev, { header: '' })).status, 400);
    assert.equal((await post(ev, { secret: 'whsec_other' })).status, 400);
    assert.equal((await post(ev, { header: 't=1,v1=deadbeef' })).status, 400);
    assert.equal(Object.keys(store).length, before);
    assert.equal(mails.length, 0);
  });

  const realStripePath = path.join(FN, 'node_modules', 'stripe');
  if (fs.existsSync(realStripePath)) {
    await t('（本物の stripe SDK）req.rawBody（Buffer）と stripe-signature で署名を検証できる', async () => {
      const RealStripe = require(realStripePath);
      realWebhooks = new RealStripe('sk_test_dummy').webhooks;
      try {
        subs.sub_RS = mkSub('sub_RS', ZP);
        const ev = mkEvent('checkout.session.completed', mkSession('sub_RS'));
        assert.equal((await post(ev)).status, 200);
        assert.equal(mails.length, 1);
        assert.equal((await post(ev, { secret: 'whsec_other' })).status, 400);
      } finally {
        realWebhooks = null;
      }
    });
  } else {
    console.log('skip - 本物の stripe SDK での署名検証（functions/node_modules が無い）');
  }

  // ---------------- 新規購入 ----------------
  await t('月払いの新規購入: キーを発行してメールを送り、Firestore に記録する（キーの形式・メールの中身は従来どおり）', async () => {
    const r = await buy('sub_A', { email: 'a@example.com' });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    const m = mails[0];
    const p = payloadOf(keyIn(m.text));
    assert.deepEqual(Object.keys(p).sort(), ['e', 'id', 'p', 'v']); // 既存のキーと同じ中身（v:1, p:"pro", e, id）
    assert.equal(p.v, 1);
    assert.equal(p.p, 'pro');
    assert.equal(p.id, sign.licenseIdFor('sub_A'));
    assert.equal(p.e, plusDays(30)); // 期間末（2日前開始の30日後）+3日 = 31日後より、今日+30日が先
    assert.equal(m.to, 'a@example.com');
    assert.doesNotMatch(m.text, /\*\*/); // プレーンテキスト
    assert.doesNotMatch(m.text, /領収書メール/);
    assert.match(m.text, /https:\/\/zenginpon\.kokokikaku\.com\/#pro/); // キーの入力画面が直接開くリンク
    assert.match(m.text, /https:\/\/billing\.stripe\.com\/p\/login\//);
    assert.match(m.text, /Proプラン（月払い）/);
    assert.match(m.text, new RegExp(`ライセンスID: ${p.id}`));
    assert.match(m.subject, /ライセンスキーをお送りします/);
    // MAIL_FROM は MiseFits と共用。差出人名は全銀ポンにし、アドレスはそのまま使う
    assert.deepEqual(m.from, { name: '全銀ポン（ここ企画）', address: 'studio@kokokikaku.com' });
    const d = lic('sub_A');
    assert.equal(d.email, 'a@example.com');
    assert.equal(d.customerId, 'cus_sub_A');
    assert.equal(d.subscriptionId, 'sub_A');
    assert.equal(d.status, 'active');
    assert.equal(d.entitledUntil, isoDay(subs.sub_A.items.data[0].current_period_end + 3 * DAY));
    assert.ok(d.stripeCheckedAt);
  });

  await t('年払いの新規購入: キーの期限は今日+30日まで、メールに「年払い」', async () => {
    await buy('sub_Y', { interval: 'year', email: 'y@example.com' });
    assert.equal(mails.length, 1);
    assert.equal(payloadOf(keyIn(mails[0].text)).e, plusDays(30));
    assert.match(mails[0].text, /Proプラン（年払い）/);
    assert.ok(lic('sub_Y').entitledUntil > plusDays(360));
  });

  await t('期間の末日が近い契約: キーの期限は期間の末日+3日（今日+30日より前）', async () => {
    await buy('sub_N', { start: now - 25 * DAY, end: now + 5 * DAY });
    assert.equal(payloadOf(keyIn(mails[0].text)).e, isoDay(now + 8 * DAY));
  });

  await t('古い形（basil より前: current_period_end がサブスクリプション直下）でも同じように発行する', async () => {
    await buy('sub_L', { legacy: true });
    assert.equal(subs.sub_L.items.data[0].current_period_end, undefined);
    assert.equal(mails.length, 1);
    assert.equal(lic('sub_L').entitledUntil, isoDay(subs.sub_L.current_period_end + 3 * DAY));
  });

  await t('チェックアウトの subscription が展開済みのオブジェクトでも読める', async () => {
    subs.sub_EX = mkSub('sub_EX', ZP);
    const s = mkSession('sub_EX');
    s.subscription = { id: 'sub_EX', object: 'subscription' };
    assert.equal((await post(mkEvent('checkout.session.completed', s))).status, 200);
    assert.equal(mails.length, 1);
  });

  await t('チェックアウトにメールが無い: customer_email → 顧客の順に補う', async () => {
    subs.sub_CE = mkSub('sub_CE', ZP);
    await post(mkEvent('checkout.session.completed', mkSession('sub_CE', { email: null, customer_email: 'prefill@example.com' })));
    assert.equal(mails[0].to, 'prefill@example.com');
    assert.equal(calls.custRetrieve, 0);
    reset();
    subs.sub_CC = mkSub('sub_CC', ZP);
    customers.cus_sub_CC = { id: 'cus_sub_CC', object: 'customer', email: 'customer@example.com' };
    await post(mkEvent('checkout.session.completed', mkSession('sub_CC', { noDetails: true })));
    assert.equal(calls.custRetrieve, 1);
    assert.equal(mails[0].to, 'customer@example.com');
  });

  await t('購入者のメールアドレスがどこにも無い: 運営者に「【要対応】」でキーを送り、200 で完了', async () => {
    subs.sub_NE = mkSub('sub_NE', ZP);
    customers.cus_sub_NE = { id: 'cus_sub_NE', object: 'customer', email: null };
    const r = await post(mkEvent('checkout.session.completed', mkSession('sub_NE', { email: null })));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'studio@kokokikaku.com');
    assert.match(mails[0].subject, /【要対応】全銀ポン.*メールアドレスが分かりません/);
    assert.match(mails[0].text, /sub_NE/);
    assert.equal(payloadOf(keyIn(mails[0].text)).id, sign.licenseIdFor('sub_NE'));
    assert.doesNotMatch(mails[0].text, /\*\*/);
  });

  await t('顧客の照会が権限不足で失敗したら、黙って諦めず 500（Stripe が再送し、運営者に知らせる）', async () => {
    subs.sub_CP = mkSub('sub_CP', ZP);
    customers.cus_sub_CP = stripeError('StripePermissionError', 'The provided key does not have the required permissions', { statusCode: 403 });
    const ev = mkEvent('checkout.session.completed', mkSession('sub_CP', { email: null }));
    assert.equal((await post(ev)).status, 500);
    assert.equal(mails.length, 0);
    customers.cus_sub_CP = { id: 'cus_sub_CP', object: 'customer', email: 'cp@example.com' }; // 権限を直して再送
    assert.equal((await post(ev)).status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'cp@example.com');
  });

  await t('支払いが済んでいない契約（incomplete）にはキーを出さず、運営者に知らせる', async () => {
    subs.sub_IC = mkSub('sub_IC', ZP, { status: 'incomplete' });
    const r = await post(mkEvent('checkout.session.completed', mkSession('sub_IC')));
    assert.equal(r.status, 200);
    assert.equal(r.body.skipped, 'not entitled');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'studio@kokokikaku.com');
    assert.doesNotMatch(mails[0].text, /ZP1-/);
    assert.equal(lic('sub_IC').entitledUntil, null);
  });

  // ---------------- 二重配信・同時到着・途中で落ちた再送 ----------------
  await t('同じイベントが二重に届いても、メールは1通だけ', async () => {
    subs.sub_D = mkSub('sub_D', ZP);
    const ev = mkEvent('checkout.session.completed', mkSession('sub_D'));
    await post(ev);
    const r = await post(ev);
    assert.equal(r.body.skipped, 'already processed');
    assert.equal(mails.length, 1);
  });

  await t('同じイベントが同時に届いたら、後の方は 409（Stripe が後で再送）で、メールは1通だけ', async () => {
    subs.sub_P = mkSub('sub_P', ZP);
    const ev = mkEvent('checkout.session.completed', mkSession('sub_P'));
    const [r1, r2] = await Promise.all([post(ev), post(ev)]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(mails.length, 1);
    const r3 = await post(ev); // Stripe の再送
    assert.equal(r3.body.skipped, 'already processed');
    assert.equal(mails.length, 1);
  });

  await t('メールを送ったあとに落ちた再送では、二重に送らず続きから完了する', async () => {
    subs.sub_R = mkSub('sub_R', ZP);
    store['zenginponEvents/evt_retry'] = { startedAt: 'x', mailedAt: 'y', leaseUntil: 0 };
    const r = await post(mkEvent('checkout.session.completed', mkSession('sub_R'), { id: 'evt_retry' }));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 0);
    assert.ok(store['zenginponEvents/evt_retry'].doneAt);
  });

  await t('印の無い古い形のイベントの記録（leaseUntil・doneAt・processingAt なし）は、途中で落ちたものとして続きから処理する', async () => {
    subs.sub_OE = mkSub('sub_OE', ZP);
    store['zenginponEvents/evt_old_form'] = { type: 'checkout.session.completed' };
    const r = await post(mkEvent('checkout.session.completed', mkSession('sub_OE'), { id: 'evt_old_form' }));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.ok(store['zenginponEvents/evt_old_form'].doneAt);
  });

  await t('メールが送れなかったら運営者に知らせて500を返し、Stripe の再送で届ける', async () => {
    subs.sub_M = mkSub('sub_M', ZP);
    failMailOnce = true;
    const ev = mkEvent('checkout.session.completed', mkSession('sub_M', { email: 'm@example.com' }));
    const r1 = await post(ev);
    assert.equal(r1.status, 500);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'studio@kokokikaku.com');
    assert.match(mails[0].subject, /【要対応】全銀ポンのメールを送れませんでした/);
    mails.length = 0;
    const r2 = await post(ev); // Stripe の再送（実行中の印は外れているので、すぐ処理できる）
    assert.equal(r2.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'm@example.com');
  });

  await t('SMTP 未設定（mailerReady=false）: 契約は記録して 500（黙って 200 にしない）。設定してから再送すると届く', async () => {
    smtpHost = '';
    subs.sub_SM = mkSub('sub_SM', ZP);
    const ev = mkEvent('checkout.session.completed', mkSession('sub_SM'));
    try {
      assert.equal((await post(ev)).status, 500);
      assert.equal(mails.length, 0);
      assert.equal(lic('sub_SM').status, 'active');
    } finally {
      smtpHost = 'smtp.example';
    }
    assert.equal((await post(ev)).status, 200);
    assert.equal(mails.length, 1);
  });

  await t('Stripe の照会に失敗（権限不足）したら 500。直してから再送すると続きから発行する（2026-10-02 の障害）', async () => {
    subs.sub_F = mkSub('sub_F', ZP);
    const ev = mkEvent('checkout.session.completed', mkSession('sub_F'));
    subRetrieveError = stripeError('StripePermissionError', 'The provided key does not have the required permissions for this endpoint', { statusCode: 403 });
    try {
      assert.equal((await post(ev)).status, 500);
    } finally {
      subRetrieveError = null;
    }
    assert.equal(lic('sub_F'), undefined);
    assert.equal(store[`zenginponEvents/${ev.id}`].doneAt, undefined);
    assert.equal(store[`zenginponEvents/${ev.id}`].leaseUntil, 0);
    assert.equal((await post(ev)).status, 200);
    assert.equal(mails.length, 1);
    assert.equal(lic('sub_F').status, 'active');
  });

  await t('送信済みの印（mailedAt）を書けずに落ちたら 500。再送ではもう一度送る（届かないより二重の方がよい）', async () => {
    subs.sub_W = mkSub('sub_W', ZP);
    const ev = mkEvent('checkout.session.completed', mkSession('sub_W'));
    setFailures.push((k, v) => k === `zenginponEvents/${ev.id}` && 'mailedAt' in v);
    assert.equal((await post(ev)).status, 500);
    assert.equal(mails.length, 1);
    assert.equal((await post(ev)).status, 200);
    assert.equal(mails.length, 2);
    assert.equal(keyIn(mails[0].text).split('.')[0], keyIn(mails[1].text).split('.')[0]); // 同じ内容のキー
  });

  // ---------------- 契約の変更 ----------------
  await t('subscription.updated でメールアドレスが消えない（null で上書きしない）', async () => {
    await post(mkEvent('customer.subscription.updated', subs.sub_A, { prev: { metadata: {} } }));
    assert.equal(lic('sub_A').email, 'a@example.com');
    assert.equal(lic('sub_A').stripeCheckedAt, null); // Webhook の写しは「照会済み」にしない
  });

  await t('月払い→年払いの切り替えで、同じライセンスIDのまま期限が延び、控えのメールが届く', async () => {
    const before = licenseDocs().length;
    const old = subs.sub_A;
    subs.sub_A = mkSub('sub_A', ZP, { interval: 'year', start: now });
    await post(mkEvent('customer.subscription.updated', subs.sub_A, { prev: { items: old.items, plan: null } }));
    const r = await post(mkEvent('invoice.paid', mkInvoice('sub_A', ZP, { reason: 'subscription_update', email: 'a@example.com', amount: 4320 })));
    assert.equal(r.status, 200);
    assert.equal(licenseDocs().length, before);
    assert.ok(lic('sub_A').entitledUntil > plusDays(300));
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /Proプランを更新しました/);
    const k = await getKey(sign.licenseIdFor('sub_A'), { origin: 'https://zenginpon.kokokikaku.com' });
    assert.equal(k.status, 200);
    assert.equal(payloadOf(k.body.key).id, sign.licenseIdFor('sub_A'));
    assert.equal(k.body.expiry, plusDays(30));
    assert.equal(k.headers['Access-Control-Allow-Origin'], 'https://zenginpon.kokokikaku.com');
    assert.equal(k.headers['Cache-Control'], 'no-store');
  });

  await t('期間末の解約（cancel_at_period_end）を受け付けた時点で「解約を承りました」が1回だけ届く', async () => {
    const s = { ...subs.sub_A, cancel_at_period_end: true, canceled_at: now };
    await post(mkEvent('customer.subscription.updated', s, { prev: { cancel_at_period_end: false, canceled_at: null } }));
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'a@example.com');
    assert.match(mails[0].subject, /解約を承りました/);
    assert.match(mails[0].text, new RegExp(`${B.jstDate(s.items.data[0].current_period_end)} までは`));
    assert.match(mails[0].text, /無料プラン（1回20件まで）/);
    assert.match(mails[0].text, /billing\.stripe\.com/);
    // 同じ状態のまま別の項目が変わっただけなら、もう一度は送らない
    mails.length = 0;
    await post(mkEvent('customer.subscription.updated', s, { prev: { metadata: {} } }));
    assert.equal(mails.length, 0);
  });

  await t('日付指定の解約（cancel_at。flexible billing のポータルもこちら）: 指定日を知らせ、キーもその日+3日まで', async () => {
    await buy('sub_CA', { email: 'ca@example.com' });
    reset();
    const at = now + 10 * DAY;
    subs.sub_CA = { ...subs.sub_CA, cancel_at: at };
    await post(mkEvent('customer.subscription.updated', subs.sub_CA, { prev: { cancel_at: null } }));
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, new RegExp(`${B.jstDate(at)} までは`));
    assert.equal(lic('sub_CA').entitledUntil, isoDay(at + 3 * DAY));
    const r = await getKey(sign.licenseIdFor('sub_CA'));
    assert.equal(payloadOf(r.body.key).e, isoDay(at + 3 * DAY));
  });

  await t('解約予約の取り消し（cancel_at → null、cancel_at_period_end → false）ではメールを送らず、期限は元に戻る', async () => {
    const at = subs.sub_CA.cancel_at;
    subs.sub_CA = { ...subs.sub_CA, cancel_at: null };
    await post(mkEvent('customer.subscription.updated', subs.sub_CA, { prev: { cancel_at: at } }));
    await post(mkEvent('customer.subscription.updated', { ...subs.sub_A, cancel_at_period_end: false }, { prev: { cancel_at_period_end: true } }));
    assert.equal(mails.length, 0);
    assert.equal(lic('sub_CA').entitledUntil, isoDay(subs.sub_CA.items.data[0].current_period_end + 3 * DAY));
  });

  await t('契約が終わったら「終了しました」が届き、猶予が過ぎると 410', async () => {
    const ended = now - 10 * DAY;
    subs.sub_A = { ...subs.sub_A, status: 'canceled', ended_at: ended, canceled_at: ended };
    await post(mkEvent('customer.subscription.deleted', subs.sub_A));
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'a@example.com');
    assert.match(mails[0].subject, /ご契約が終了しました/);
    assert.match(mails[0].text, /無料プラン（1回20件まで）は、これまでどおり/);
    assert.equal(lic('sub_A').status, 'canceled');
    const r = await getKey(sign.licenseIdFor('sub_A'));
    assert.equal(r.status, 410);
    assert.equal(r.body.entitledUntil, isoDay(ended + 3 * DAY));
  });

  await t('解約の後に、順番が前後した古い subscription.updated が届いても「契約中」に戻さない', async () => {
    const stale = { ...subs.sub_A, status: 'active', ended_at: null };
    const r = await post(mkEvent('customer.subscription.updated', stale, { prev: { cancel_at_period_end: false } }));
    assert.equal(r.body.skipped, 'stale (already ended)');
    assert.equal(lic('sub_A').status, 'canceled');
    assert.equal(mails.length, 0);
  });

  await t('subscription.deleted で契約の記録が無い: 200 で記録だけ残し、メールは送らない', async () => {
    const s = mkSub('sub_GONE', ZP, { status: 'canceled', ended_at: now - DAY });
    const r = await post(mkEvent('customer.subscription.deleted', s));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 0);
    assert.equal(lic('sub_GONE').status, 'canceled');
    assert.equal(lic('sub_GONE').subscriptionId, 'sub_GONE');
  });

  // ---------------- 更新の請求 ----------------
  await t('初回の invoice.paid（subscription_create）はチェックアウトと二重に送らない', async () => {
    subs.sub_C = mkSub('sub_C', ZP);
    await post(mkEvent('checkout.session.completed', mkSession('sub_C', { email: 'c@example.com' })));
    const r = await post(mkEvent('invoice.paid', mkInvoice('sub_C', ZP, { reason: 'subscription_create', email: 'c@example.com' })));
    assert.equal(r.body.skipped, 'initial invoice (handled by checkout)');
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /ライセンスキーをお送りします/);
  });

  await t('更新（2回目以降の請求）でキーの控えを送る', async () => {
    subs.sub_C = mkSub('sub_C', ZP, { start: now, end: now + 30 * DAY });
    const r = await post(mkEvent('invoice.paid', mkInvoice('sub_C', ZP, { email: 'c@example.com' })));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /Proプランを更新しました/);
    assert.match(mails[0].text, new RegExp(`このキー自体の有効期限: ${plusDays(30)}`));
    assert.doesNotMatch(mails[0].text, /\*\*/);
  });

  await t('古い形の請求書（invoice.subscription・明細の price.product）でも更新できる', async () => {
    const r = await post(mkEvent('invoice.paid', mkInvoice('sub_C', ZP, { legacy: true, email: 'c@example.com' })));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
  });

  await t('invoice.paid に customer_email が無い: Firestore のメール → 顧客の照会の順に補う／顧客が削除済みなら運営者へ', async () => {
    await post(mkEvent('invoice.paid', mkInvoice('sub_C', ZP, { email: null })));
    assert.equal(mails[0].to, 'c@example.com'); // 購入時に記録したもの
    assert.equal(calls.custRetrieve, 0);
    reset();
    subs.sub_NC = mkSub('sub_NC', ZP);
    customers.cus_sub_NC = { id: 'cus_sub_NC', object: 'customer', email: 'nc@example.com' };
    await post(mkEvent('invoice.paid', mkInvoice('sub_NC', ZP, { email: null })));
    assert.equal(calls.custRetrieve, 1);
    assert.equal(mails[0].to, 'nc@example.com');
    reset();
    subs.sub_DEL = mkSub('sub_DEL', ZP);
    customers.cus_sub_DEL = { id: 'cus_sub_DEL', object: 'customer', deleted: true };
    const r = await post(mkEvent('invoice.paid', mkInvoice('sub_DEL', ZP, { email: null })));
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'studio@kokokikaku.com');
    assert.match(mails[0].subject, /【要対応】全銀ポン/);
  });

  // ---------------- 2026-10-15 より前の Firestore の記録 ----------------
  await t('以前の形の記録（stripeCheckedAt なし。email・customerId・subscriptionId・status・entitledUntil・updatedAt だけ）: キー更新も更新の請求もそのまま動く', async () => {
    subs.sub_OLD = mkSub('sub_OLD', ZP, { start: now - 5 * DAY });
    const id = sign.licenseIdFor('sub_OLD');
    store[`zenginponLicenses/${id}`] = { email: 'old@example.com', customerId: 'cus_sub_OLD', subscriptionId: 'sub_OLD', status: 'active', entitledUntil: plusDays(28), updatedAt: '2026-10-03T00:00:00.000Z' };
    const r = await getKey(id);
    assert.equal(r.status, 200);
    assert.equal(calls.subRetrieve, 1); // 記録が古いので Stripe に照会する
    assert.equal(payloadOf(r.body.key).id, id);
    assert.equal(r.body.expiry, isoDay(now + 28 * DAY)); // 期間末（25日後）+3日
    assert.ok(lic('sub_OLD').stripeCheckedAt);
    assert.equal(lic('sub_OLD').email, 'old@example.com');
    reset();
    const r2 = await post(mkEvent('invoice.paid', mkInvoice('sub_OLD', ZP, { email: null })));
    assert.equal(r2.status, 200);
    assert.equal(mails[0].to, 'old@example.com'); // 記録のメールを使う（顧客を照会しない）
    assert.equal(calls.custRetrieve, 0);
  });

  // ---------------- ほかの製品 ----------------
  await t('ほかの製品（有休ポン・MiseFits）のイベントは完全に無視する（キー・メール・記録なし、照会も最小限）', async () => {
    const beforeLic = licenseDocs().length;
    for (const product of [YUKYU, MISEFITS]) {
      const id = `sub_O_${product}`;
      subs[id] = mkSub(id, product);
      const beforeEv = eventDocs().length;
      reset();
      // チェックアウトは商品を知るために1回だけ照会する
      assert.equal((await post(mkEvent('checkout.session.completed', mkSession(id)))).body.skipped, 'other product');
      assert.equal(calls.subRetrieve, 1);
      // 請求書は明細の商品で判断し、照会しない（新旧どちらの形でも）
      assert.equal((await post(mkEvent('invoice.paid', mkInvoice(id, product)))).body.skipped, 'other product');
      assert.equal((await post(mkEvent('invoice.paid', mkInvoice(id, product, { legacy: true })))).body.skipped, 'other product');
      assert.equal((await post(mkEvent('customer.subscription.updated', subs[id], { prev: { cancel_at_period_end: false } }))).body.skipped, 'other product');
      assert.equal((await post(mkEvent('customer.subscription.deleted', { ...subs[id], status: 'canceled', ended_at: now }))).body.skipped, 'other product');
      assert.equal(calls.subRetrieve, 1);
      assert.equal(eventDocs().length, beforeEv + 1); // チェックアウトの分だけ（処理済みの印）
      assert.equal(mails.length, 0);
    }
    assert.equal(licenseDocs().length, beforeLic);
  });

  await t('明細が読めない請求書は、照会して商品を確かめる（ほかの製品ならキーを出さない）', async () => {
    subs.sub_UNK = mkSub('sub_UNK', MISEFITS);
    const inv = { ...mkInvoice('sub_UNK', MISEFITS), lines: { object: 'list', data: [], has_more: true } };
    const r = await post(mkEvent('invoice.paid', inv));
    assert.equal(r.body.skipped, 'other product');
    assert.equal(calls.subRetrieve, 1);
    assert.equal(mails.length, 0);
  });

  await t('MiseFits の買い切り（mode=payment）・ほかの種類のイベントは素通り', async () => {
    const r = await post(mkEvent('checkout.session.completed', mkSession(null, { mode: 'payment' })));
    assert.equal(r.body.skipped, 'not a subscription');
    const r2 = await post(mkEvent('invoice.payment_failed', mkInvoice('sub_C', ZP)));
    assert.equal(r2.body.skipped, 'unhandled type');
    const r3 = await post(mkEvent('invoice.paid', { ...mkInvoice('x', ZP), parent: null, lines: { object: 'list', data: [], has_more: false } }));
    assert.equal(r3.body.skipped, 'no subscription');
    assert.equal(mails.length, 0);
  });

  // ---------------- キー更新エンドポイント ----------------
  await t('キー更新: 不正なIDは400、未登録は404、OPTIONS は 204、GET 以外は 405、他サイトには CORS を許可しない', async () => {
    assert.equal((await getKey('ab')).status, 400);
    assert.equal((await getKey('a/b..c')).status, 400);
    assert.equal((await getKey('unknown123')).status, 404);
    const o = await getKey('unknown123', { method: 'OPTIONS', origin: 'https://zenginpon.kokokikaku.com' });
    assert.equal(o.status, 204);
    assert.equal(o.headers['Access-Control-Allow-Methods'], 'GET');
    assert.equal(o.headers['Access-Control-Allow-Origin'], 'https://zenginpon.kokokikaku.com');
    assert.equal((await getKey(sign.licenseIdFor('sub_C'), { method: 'POST' })).status, 405);
    const r = await getKey(sign.licenseIdFor('sub_C'), { origin: 'https://evil.example' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Access-Control-Allow-Origin'], undefined);
    assert.equal(r.body.expiry, plusDays(30));
    assert.equal(r.body.status, 'active');
  });

  /** 契約を Firestore に用意し、Stripe 側の状態を差し替えてキー更新を呼ぶ */
  const withStatus = async (name, o) => {
    const id = `sub_ST_${name}`;
    subs[id] = mkSub(id, ZP);
    await post(mkEvent('checkout.session.completed', mkSession(id)));
    store[`zenginponLicenses/${sign.licenseIdFor(id)}`].stripeCheckedAt = null; // 照会させる
    subs[id] = mkSub(id, ZP, o);
    return getKey(sign.licenseIdFor(id));
  };

  await t('キー更新: active・trialing は延長、past_due は期間の初日+30日まで（+猶予）', async () => {
    assert.equal((await withStatus('active', {})).status, 200);
    assert.equal((await withStatus('trialing', { status: 'trialing' })).status, 200);
    const pd = await withStatus('pdue', { status: 'past_due', interval: 'year', start: now - 5 * DAY, end: now + 360 * DAY });
    assert.equal(pd.status, 200);
    assert.equal(pd.body.expiry, isoDay(now - 5 * DAY + 33 * DAY)); // 年払いでも1年は延ばさない
    const pdOld = await withStatus('pdue_old', { status: 'past_due', interval: 'year', start: now - 40 * DAY, end: now + 325 * DAY });
    assert.equal(pdOld.status, 410);
  });

  await t('キー更新: unpaid・paused は支払い済みの期間（今の期間の初日+猶予）まで、incomplete・incomplete_expired・canceled は 410', async () => {
    assert.equal((await withStatus('unpaid', { status: 'unpaid', start: now - 10 * DAY })).status, 410);
    const recent = await withStatus('unpaid_recent', { status: 'unpaid', start: now - DAY });
    assert.equal(recent.status, 200);
    assert.equal(recent.body.expiry, isoDay(now - DAY + 3 * DAY));
    assert.equal((await withStatus('paused', { status: 'paused', start: now - 10 * DAY })).status, 410);
    assert.equal((await withStatus('incomplete', { status: 'incomplete' })).status, 410);
    assert.equal((await withStatus('incomplete_expired', { status: 'incomplete_expired' })).status, 410);
    assert.equal((await withStatus('canceled', { status: 'canceled', ended_at: now - 5 * DAY })).status, 410);
    const justEnded = await withStatus('canceled_now', { status: 'canceled', ended_at: now });
    assert.equal(justEnded.status, 200); // 即時解約（返金）でも猶予の3日は使える
    assert.equal(justEnded.body.expiry, isoDay(now + 3 * DAY));
  });

  await t('キー更新: Stripe の照会に失敗したら Firestore の値で判定（期限内なら延長）', async () => {
    const id = sign.licenseIdFor('sub_C');
    store[`zenginponLicenses/${id}`].stripeCheckedAt = null;
    subRetrieveError = stripeError('StripeConnectionError', 'An error occurred with our connection to Stripe');
    try {
      const r = await getKey(id);
      assert.equal(r.status, 200);
      store['zenginponLicenses/oldform01'] = { subscriptionId: 'sub_C', status: 'active', entitledUntil: plusDays(20) };
      const r2 = await getKey('oldform01');
      assert.equal(r2.status, 200);
      assert.equal(r2.body.expiry, plusDays(20));
    } finally {
      subRetrieveError = null;
    }
  });

  await t('キー更新: Stripe に照会できず Firestore の期限が過ぎている → 503（キーを消させない）。解約を Webhook で受け取っていれば 410', async () => {
    store['zenginponLicenses/stalekey01'] = { subscriptionId: 'sub_C', status: 'active', entitledUntil: plusDays(-1) };
    store['zenginponLicenses/canceled01'] = { subscriptionId: 'sub_C', status: 'canceled', entitledUntil: plusDays(-1) };
    subRetrieveError = stripeError('StripeAPIError', 'Internal server error', { statusCode: 500 });
    try {
      const r = await getKey('stalekey01');
      assert.equal(r.status, 503);
      assert.equal(r.headers['Retry-After'], '3600');
      assert.equal((await getKey('canceled01')).status, 410);
    } finally {
      subRetrieveError = null;
    }
    // 照会できるようになれば、Stripe の状態（契約中）で延長する
    const r2 = await getKey('stalekey01');
    assert.equal(r2.status, 200);
  });

  await t('キー更新の連打: 10分以内に Stripe で確かめていれば照会しない。Webhook で状態が変わったら次は照会する', async () => {
    const id = sign.licenseIdFor('sub_C');
    store[`zenginponLicenses/${id}`].stripeCheckedAt = null;
    reset();
    for (let i = 0; i < 5; i++) assert.equal((await getKey(id)).status, 200);
    assert.equal(calls.subRetrieve, 1);
    await post(mkEvent('customer.subscription.updated', subs.sub_C, { prev: { metadata: {} } }));
    await getKey(id);
    assert.equal(calls.subRetrieve, 2);
  });

  await t('キー更新: Firestore への書き込みに失敗しても、Stripe で確かめた結果でキーを返す', async () => {
    const id = sign.licenseIdFor('sub_C');
    store[`zenginponLicenses/${id}`].stripeCheckedAt = null;
    setFailures.push((k) => k === `zenginponLicenses/${id}`);
    const r = await getKey(id);
    assert.equal(r.status, 200);
    assert.equal(setFailures.length, 0);
  });

  // ---------------- 判定の単体 ----------------
  await t('entitledUntilOf: 新旧の形・状態ごとの最終日', async () => {
    const s = (o) => mkSub('sub_U', ZP, { start: now, end: now + 30 * DAY, ...o });
    assert.equal(B.entitledUntilOf(s({})), isoDay(now + 33 * DAY));
    assert.equal(B.entitledUntilOf(s({ legacy: true })), isoDay(now + 33 * DAY));
    assert.equal(B.entitledUntilOf(s({ cancel_at: now + 5 * DAY })), isoDay(now + 8 * DAY));
    assert.equal(B.entitledUntilOf(s({ cancel_at: now + 90 * DAY })), isoDay(now + 33 * DAY)); // 期間より先の指定日は期間末で区切る（次の請求で延びる）
    assert.equal(B.entitledUntilOf(s({ status: 'canceled', ended_at: now + DAY })), isoDay(now + 4 * DAY));
    assert.equal(B.entitledUntilOf(s({ status: 'incomplete' })), null);
    assert.equal(B.entitledUntilOf(s({ status: 'incomplete_expired' })), null);
    assert.equal(B.entitledUntilOf(s({ status: 'unpaid' })), isoDay(now + 3 * DAY));
  });

  await t('sign.js: ライセンスIDは契約ごとに固定の12文字（既存のお客さまと同じ作り方）、cappedExpiry は min(期間末+猶予, 今日+上限)', async () => {
    assert.equal(sign.licenseIdFor('sub_A'), sign.licenseIdFor('sub_A'));
    assert.notEqual(sign.licenseIdFor('sub_A'), sign.licenseIdFor('sub_B'));
    assert.equal(sign.licenseIdFor('sub_A'), crypto.createHash('sha256').update('sub_A').digest('base64url').slice(0, 12));
    assert.match(sign.licenseIdFor('sub_1TestABC'), /^[A-Za-z0-9_-]{12}$/);
    assert.equal(sign.cappedExpiry(now + 100 * DAY, 3, 30), plusDays(30));
    assert.equal(sign.cappedExpiry(now + 2 * DAY, 3, 30), plusDays(5));
    assert.equal(B.keyExpiry(plusDays(400)), plusDays(30));
    assert.equal(B.keyExpiry(plusDays(4)), plusDays(4));
  });

  await t('関数の設定: 東京リージョン、インスタンス数の上限、必要なシークレット', async () => {
    const w = fns.zenginponStripeWebhook.opts;
    const l = fns.zenginponLicense.opts;
    assert.equal(w.region, 'asia-northeast1');
    assert.equal(l.region, 'asia-northeast1');
    assert.ok(w.maxInstances > 0 && l.maxInstances > 0);
    assert.equal(l.cors, false);
    assert.equal(w.secrets.length, 6);
    assert.equal(l.secrets.length, 2);
  });

  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
