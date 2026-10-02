// node test/functions.test.js — Webhook の全経路を、Stripe・Firestore・メールを差し替えて確かめる
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const FN = path.join(__dirname, '..', 'functions');
const ZP = 'prod_VEa5100IEJu6JE';
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// ---- 差し替え ----
const store = {};               // Firestore の代わり
const mails = [];               // 送ったメール
let subs = {};                  // Stripe の契約
let customers = {};
const handlers = {};
const fakes = {
  'firebase-functions/v2/https': { onRequest: (_opts, fn) => fn },
  'firebase-functions/params': {
    defineSecret: (n) => ({ value: () => (n === 'ZP_LICENSE_PRIVATE_KEY' ? PEM : 'x') }),
    defineString: (n, o) => ({ value: () => (n === 'SMTP_HOST' ? 'smtp.example' : (o && o.default) || '') }),
  },
  'firebase-admin/app': { initializeApp() {}, getApps: () => [1] },
  'firebase-admin/firestore': { getFirestore: () => ({ collection: () => ({ doc: (id) => ({
    async set(v, o) { store[id] = o && o.merge ? { ...(store[id] || {}), ...v } : { ...v }; },
    async get() { return { exists: !!store[id], data: () => store[id] }; },
  }) }) }) },
  stripe: function Stripe() { return {
    webhooks: { constructEvent: (body) => JSON.parse(body) },
    subscriptions: { retrieve: async (id) => { if (!subs[id]) throw new Error('no sub ' + id); return subs[id]; } },
    customers: { retrieve: async (id) => customers[id] },
  }; },
  nodemailer: { createTransport: () => ({ sendMail: async (m) => { mails.push(m); } }) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fakes[req] || origLoad.call(this, req, ...rest); };
const fns = require(path.join(FN, 'index.js'));
Module._load = origLoad;

const now = Math.floor(Date.now() / 1000);
const mkSub = (id, product, extra = {}) => ({ id, customer: 'cus_' + id, status: 'active',
  items: { data: [{ current_period_end: now + 30 * 86400, price: { product, recurring: { interval: 'month' } } }] }, ...extra });

async function post(event) {
  let status = 200, body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, send(b) { body = b; return this; } };
  await fns.zenginponStripeWebhook({ rawBody: JSON.stringify(event), headers: {} }, res);
  return { status, body };
}

(async () => {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

  await t('新規購入でキーを発行してメールを送る', async () => {
    subs.sub_A = mkSub('sub_A', ZP);
    const r = await post({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_A', customer_details: { email: 'a@example.com' } } } });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /ZP1-/);
    assert.doesNotMatch(mails[0].text, /\*\*/);
    assert.doesNotMatch(mails[0].text, /領収書メール/);
    assert.match(mails[0].text, /https:\/\/billing\.stripe\.com\/p\/login\//);
  });

  await t('subscription.updated でメールアドレスが消えない', async () => {
    const id = Object.keys(store)[0];
    await post({ type: 'customer.subscription.updated', data: { object: { ...subs.sub_A, cancel_at_period_end: true } } });
    assert.equal(store[id].email, 'a@example.com');
  });

  await t('解約で解約メールが届く', async () => {
    mails.length = 0;
    const r = await post({ type: 'customer.subscription.deleted', data: { object: { ...subs.sub_A, status: 'canceled', ended_at: now } } });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'a@example.com');
    assert.match(mails[0].subject, /解約/);
  });

  await t('更新（2回目以降の請求）でキーの控えを送る', async () => {
    mails.length = 0;
    subs.sub_A = mkSub('sub_A', ZP);
    const r = await post({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle', customer_email: 'a@example.com', parent: { subscription_details: { subscription: 'sub_A' } } } } });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /更新/);
  });

  await t('初回の invoice.paid は二重に送らない', async () => {
    mails.length = 0;
    const r = await post({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_create', subscription: 'sub_A' } } });
    assert.equal(r.status, 200);
    assert.equal(mails.length, 0);
  });

  await t('ほかの商品の契約にはキーを出さない', async () => {
    mails.length = 0;
    const before = Object.keys(store).length;
    subs.sub_B = mkSub('sub_B', 'prod_OTHER');
    await post({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_B', customer_details: { email: 'b@example.com' } } } });
    await post({ type: 'invoice.paid', data: { object: { billing_reason: 'subscription_cycle', subscription: 'sub_B' } } });
    await post({ type: 'customer.subscription.updated', data: { object: subs.sub_B } });
    await post({ type: 'customer.subscription.deleted', data: { object: subs.sub_B } });
    assert.equal(mails.length, 0);
    assert.equal(Object.keys(store).length, before);
  });

  await t('買い切り（mode=payment）の決済は素通りする', async () => {
    const r = await post({ type: 'checkout.session.completed', data: { object: { mode: 'payment' } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.skipped, 'not a subscription');
  });

  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
