/*
 * 全銀ポン Pro のライセンス発行API（Stripe Webhook + キー更新エンドポイント）
 *
 * 方針:
 *   月払いも年払いも Stripe のサブスクリプション（自動更新）。
 *   ライセンスキーはオフラインで検証できる署名付きトークンなので、そのままだと解約しても
 *   期限まで使えてしまう。そこで **キーの寿命を短く（既定30日）** して、ブラウザが定期的に
 *   取り直す設計にした。取り直すたびに Stripe の契約状態を見に行くので、
 *
 *     - 契約中        → 期限を「今日+30日」まで延ばして返す（年払いでも同じ。利用者は気づかない）
 *     - 解約・未払い  → 410 を返す。ブラウザは保存済みのキーを削除して Free に戻る
 *     - 期間末で解約  → 期間の末日+猶予までは延ばすが、それ以上は延ばさない → 自然に失効
 *
 *   完全にオフラインで使い続けた場合でも、手元のキーは最長30日で切れる。
 *
 * 置き場所:
 *   既存の Firebase プロジェクト "misefits"（Blaze 設定済み）に codebase "zenginpon" として相乗りする。
 *   codebase を分けているので、ここから deploy しても Misefits 側の関数は消えない。
 *   Firestore のルールはこのリポジトリからは配らない（firebase.json に firestore を書いていない）。
 *
 * 必要なシークレット（Secret Manager）:
 *   STRIPE_SECRET_KEY         … Misefits と共通で可
 *   ZP_STRIPE_WEBHOOK_SECRET  … この Webhook エンドポイント専用（Stripe が発行する whsec_...）
 *   ZP_LICENSE_PRIVATE_KEY    … ~/.zengin-pon/license-private.pem の中身そのまま
 *   SMTP_USER / MAIL_FROM / SMTP_PASS … Misefits と共通で可
 * 通常パラメータ（functions/.env）:
 *   SMTP_HOST / SMTP_PORT
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { licenseIdFor, signKey, expiryFromUnix, daysFromToday, cappedExpiry } = require('./sign');

if (!getApps().length) initializeApp();
const db = getFirestore();

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const zpWebhookSecret = defineSecret('ZP_STRIPE_WEBHOOK_SECRET');
const zpPrivateKey = defineSecret('ZP_LICENSE_PRIVATE_KEY');
const smtpUser = defineSecret('SMTP_USER');
const mailFrom = defineSecret('MAIL_FROM');
const smtpPass = defineSecret('SMTP_PASS');
const smtpHost = defineString('SMTP_HOST', { default: '' });
const smtpPort = defineString('SMTP_PORT', { default: '465' });

const SITE = 'https://zenginpon.kokokikaku.com';
const COLLECTION = 'zenginponLicenses';
const GRACE_DAYS = 3;          // 契約期間の末日を過ぎても数日は使える（更新の行き違い対策）
const MAX_OFFLINE_DAYS = 30;   // キーの最長寿命。これを超える期限は発行しない
const ACTIVE = ['active', 'trialing', 'past_due'];  // past_due は Stripe が再請求中なので使わせる
const ALLOWED_ORIGINS = [SITE, 'http://localhost:8877'];
// Stripe アカウントは MiseFits / MenuFits と共用。全銀ポン Pro 以外の契約にはキーを出さない。
const ZP_PRODUCT_ID = 'prod_VEa5100IEJu6JE';
// Stripe カスタマーポータルのログインリンク（設定 → Billing → カスタマーポータル → 「リンクを有効化」で発行）。
// 空のあいだは「メールへの返信で解約」と案内する。
const PORTAL_URL = 'https://billing.stripe.com/p/login/cNi7sEb0eg2g7HtcOv9R600';

function cancelHow() {
  return PORTAL_URL
    ? `次のページから、ご登録のメールアドレスでいつでも解約できます（このメールへのご返信でも承ります）。
${PORTAL_URL}`
    : 'このメールにご返信いただければ、解約を承ります（いつでも可能です）。';
}

// ------------------------------------------------------------
// メール
// ------------------------------------------------------------
function mailerReady() {
  return !!(smtpHost.value() && smtpUser.value() && mailFrom.value() && smtpPass.value());
}
async function sendMail(to, subject, text) {
  if (!mailerReady()) { console.warn('SMTP 未設定のためメール送信をスキップ:', to, subject); return false; }
  const transport = nodemailer.createTransport({
    host: smtpHost.value(), port: Number(smtpPort.value()), secure: Number(smtpPort.value()) === 465,
    auth: { user: smtpUser.value(), pass: smtpPass.value() },
  });
  await transport.sendMail({ from: fromHeader(mailFrom.value()), to, subject, text });
  return true;
}

// MAIL_FROM は MiseFits と共用（「MiseFits <studio@…>」）。アドレスだけ使い、表示名は全銀ポンにする。
// 共用の値を書き換えると MiseFits のメールの差出人が変わるので、こちらで差し替える。
const SENDER_NAME = '全銀ポン（ここ企画）';
function fromHeader(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = m ? m[1] : s;
  return { name: SENDER_NAME, address };
}

function welcomeMail(key, id, planLabel) {
  return `このたびは全銀ポン Proプラン（${planLabel}）をお申し込みいただき、ありがとうございます。
ライセンスキーをお送りします。

────────────────────────────
${key}
────────────────────────────

【使い方】
1. ${SITE}/ を開く
2. 「いますぐ変換」の右にある「⭐ Pro」ボタンを押す
3. 上のキーを貼り付けて「有効にする」を押す

これで件数無制限になり、列の割り当ての保存・振込元プロファイル・変換履歴・
バックアップが使えるようになります。会社のPCと自宅のPCなど、2台までご利用いただけます。

【キーの有効期限について】
キーには短い有効期限が入っていますが、ご契約が続いているかぎり、サイトを開いたときに
自動で更新されます（貼り直しの必要はありません）。ご契約は自動更新のため、
解約のお手続きをされない限り、そのままお使いいただけます。

うまく更新されないときは「⭐ Pro」ボタンの「更新を確認」を押してください。
このメールのキーを貼り直しても復帰できますので、保管をお願いします。

【解約について】
${cancelHow()}
解約後は、お支払い済みの期間の末日までご利用いただけます。

ご不明な点、取込エラーなどありましたら、このメールにご返信ください。
※ 振込先の一覧やファイルそのものはお送りにならないでください。

--
全銀ポン（ここ企画）
${SITE}/
（ライセンスID: ${id}）`;
}

function renewalMail(key, expiry, id) {
  return `全銀ポン Proプランのお支払いを確認しました。ありがとうございます。

サイトを開いていればキーは自動で更新されますので、通常この作業は不要です。
念のため、新しいキーの控えをお送りします。

────────────────────────────
${key}
────────────────────────────

（このキー自体の有効期限: ${expiry}。ご契約中は自動で延長されます）

--
全銀ポン（ここ企画）
${SITE}/
（ライセンスID: ${id}）`;
}

/** Unix秒 → 日本時間の「2026年11月2日」 */
function jstDate(unix) {
  const d = new Date((Number(unix) + 9 * 3600) * 1000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** 解約の手続きを受け付けたとき（期間の末日で終わる予約） */
function cancelScheduledMail(endDate) {
  return `全銀ポン Proプランの解約を承りました。

${endDate} までは、これまでどおり Pro の機能をご利用いただけます。
その後は自動的に無料プラン（1回20件まで）に戻ります。お手続きは不要です。
期間中であれば、契約の管理ページから解約を取り消すこともできます。
${PORTAL_URL}

またのご利用をお待ちしています。ご不便な点がありましたら、
このメールにご返信いただけると今後の改善に役立ちます。

--
全銀ポン（ここ企画）
${SITE}/`;
}

/** 契約が終わったとき（期間の末日、または即時の解約） */
function canceledMail() {
  return `全銀ポン Proプランのご契約が終了しました。これまでのご利用ありがとうございました。

無料プラン（1回20件まで）は、これまでどおりお使いいただけます。
作成済みの設定やデータは、このブラウザに残っています。

またのご利用をお待ちしています。ご不便な点がありましたら、
このメールにご返信いただけると今後の改善に役立ちます。

--
全銀ポン（ここ企画）
${SITE}/`;
}

// ------------------------------------------------------------
// 共通処理
// ------------------------------------------------------------
function periodEndOf(subscription) {
  return subscription.current_period_end
    || (subscription.items && subscription.items.data[0] && subscription.items.data[0].current_period_end);
}

function planLabelOf(subscription) {
  const item = subscription.items && subscription.items.data[0];
  const interval = item && item.price && item.price.recurring && item.price.recurring.interval;
  return interval === 'year' ? '年払い' : '月払い';
}

/** 全銀ポン Pro の契約か（同じ Stripe アカウントのほかの商品を誤って処理しない） */
function isZenginPon(subscription) {
  const items = (subscription.items && subscription.items.data) || [];
  return items.some((it) => {
    const p = it.price && it.price.product;
    return (typeof p === 'string' ? p : p && p.id) === ZP_PRODUCT_ID;
  });
}

async function emailOf(stripe, subscription, fallback) {
  if (fallback) return fallback;
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    return (customer && !customer.deleted && customer.email) || null;
  } catch (e) { console.error('顧客のメール取得に失敗', e); return null; }
}

/** 契約状態から「この契約の最終利用可能日」を決めて Firestore に保存する */
async function saveState(subscription, email) {
  const id = licenseIdFor(subscription.id);
  const periodEnd = periodEndOf(subscription);
  if (!periodEnd) throw new Error(`current_period_end が取れません: ${subscription.id}`);
  // email は分かったときだけ書く（subscription.updated では null なので、上書きして消さない）
  await db.collection(COLLECTION).doc(id).set({
    ...(email ? { email } : {}),
    customerId: subscription.customer || null,
    subscriptionId: subscription.id,
    status: subscription.status || 'active',
    // 契約として使える最終日（ここが上限。キーの期限はこれと30日先の小さいほう）
    entitledUntil: expiryFromUnix(periodEnd, GRACE_DAYS),
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return { id, periodEnd };
}

/** 実際に配るキーを作る */
function makeKey(periodEndUnix, id) {
  const expiry = cappedExpiry(periodEndUnix, GRACE_DAYS, MAX_OFFLINE_DAYS);
  return { key: signKey(zpPrivateKey.value(), expiry, id), expiry };
}

// ------------------------------------------------------------
// Stripe Webhook
// ------------------------------------------------------------
exports.zenginponStripeWebhook = onRequest(
  { secrets: [stripeSecretKey, zpWebhookSecret, zpPrivateKey, smtpUser, mailFrom, smtpPass], region: 'asia-northeast1' },
  async (req, res) => {
    const stripe = new Stripe(stripeSecretKey.value());
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], zpWebhookSecret.value());
    } catch (e) {
      console.error('署名検証に失敗', e.message);
      res.status(400).send(`Webhook Error: ${e.message}`);
      return;
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) { res.json({ received: true, skipped: 'not a subscription' }); return; }
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        if (!isZenginPon(sub)) { res.json({ received: true, skipped: 'other product' }); return; }
        const email = await emailOf(stripe, sub, session.customer_details && session.customer_details.email);
        const { id, periodEnd } = await saveState(sub, email);
        const { key, expiry } = makeKey(periodEnd, id);
        if (email) await sendMail(email, '【全銀ポン】Proプランのライセンスキーをお送りします', welcomeMail(key, id, planLabelOf(sub)));
        console.log('新規発行', id, expiry);

      } else if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const subId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
        if (!subId) { res.json({ received: true, skipped: 'no subscription' }); return; }
        if (invoice.billing_reason === 'subscription_create') { res.json({ received: true, skipped: 'initial invoice (handled by checkout)' }); return; }
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!isZenginPon(sub)) { res.json({ received: true, skipped: 'other product' }); return; }
        const email = await emailOf(stripe, sub, invoice.customer_email);
        const { id, periodEnd } = await saveState(sub, email);
        const { key, expiry } = makeKey(periodEnd, id);
        if (email) await sendMail(email, '【全銀ポン】Proプランを更新しました', renewalMail(key, expiry, id));
        console.log('更新発行', id, expiry);

      } else if (event.type === 'customer.subscription.deleted') {
        // 即時解約なら ended_at が「今」。期間末解約なら ended_at は期間の末日。
        const sub = event.data.object;
        if (!isZenginPon(sub)) { res.json({ received: true, skipped: 'other product' }); return; }
        const id = licenseIdFor(sub.id);
        const end = sub.ended_at || periodEndOf(sub);
        const entitledUntil = expiryFromUnix(end, GRACE_DAYS);
        await db.collection(COLLECTION).doc(id).set({ status: sub.status || 'canceled', entitledUntil, updatedAt: new Date().toISOString() }, { merge: true });
        const snap = await db.collection(COLLECTION).doc(id).get();
        const email = snap.exists && snap.data().email;
        if (email) await sendMail(email, '【全銀ポン】Proプランのご契約が終了しました', canceledMail());
        console.log('解約', id, entitledUntil);

      } else if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        if (!isZenginPon(sub)) { res.json({ received: true, skipped: 'other product' }); return; }
        await saveState(sub, null);
        // 解約の予約（期間の末日で終わる）を受け付けた瞬間に、いつまで使えるかを知らせる。
        // subscription.deleted は期間の末日に届くので、そこで「承りました」と送ると遅すぎる。
        const prev = (event.data && event.data.previous_attributes) || {};
        const nowScheduled = !!(sub.cancel_at_period_end || sub.cancel_at);
        const wasScheduled = ('cancel_at_period_end' in prev || 'cancel_at' in prev) ? !!(prev.cancel_at_period_end || prev.cancel_at) : nowScheduled;
        if (nowScheduled && !wasScheduled) {
          const snap = await db.collection(COLLECTION).doc(licenseIdFor(sub.id)).get();
          const email = snap.exists && snap.data().email;
          const end = sub.cancel_at || periodEndOf(sub);
          if (email && end) await sendMail(email, '【全銀ポン】Proプランの解約を承りました', cancelScheduledMail(jstDate(end)));
        }
        console.log('状態更新', licenseIdFor(sub.id), sub.status, nowScheduled ? '解約予約あり' : '');
      }
      res.json({ received: true });
    } catch (e) {
      console.error('処理に失敗', e);
      res.status(500).send('internal error');
    }
  }
);

// ------------------------------------------------------------
// キー更新エンドポイント（ブラウザが定期的に叩く）
//   GET ?id=<ライセンスID>
//     200 { key, expiry }  … 契約中
//     410 { error }        … 解約済み・期限切れ（ブラウザは保存済みキーを消す）
//   送られてくるのはライセンスIDだけ。振込データは一切扱わない。
// ------------------------------------------------------------
exports.zenginponLicense = onRequest(
  { secrets: [stripeSecretKey, zpPrivateKey], region: 'asia-northeast1', cors: false },
  async (req, res) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods', 'GET'); res.status(204).send(''); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }

    const id = String(req.query.id || '');
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
    res.set('Cache-Control', 'no-store');

    try {
      const snap = await db.collection(COLLECTION).doc(id).get();
      if (!snap.exists) { res.status(404).json({ error: 'not found' }); return; }
      const d = snap.data();
      const today = new Date().toISOString().slice(0, 10);

      // Stripe に現在の契約状態を直接確認する（Webhook の取りこぼしがあっても正しく判定できる）
      let sub = null;
      try {
        const stripe = new Stripe(stripeSecretKey.value());
        sub = await stripe.subscriptions.retrieve(d.subscriptionId);
      } catch (e) {
        console.error('Stripe 参照に失敗、Firestore の値で判定します', e.message);
      }

      let entitledUntil = d.entitledUntil || null;
      let periodEnd = null;
      if (sub) {
        periodEnd = periodEndOf(sub);
        if (!ACTIVE.includes(sub.status)) {
          // 解約済み。支払い済み期間の末日までは使わせる
          const end = sub.ended_at || periodEnd;
          entitledUntil = end ? expiryFromUnix(end, GRACE_DAYS) : today;
        } else if (periodEnd) {
          entitledUntil = expiryFromUnix(periodEnd, GRACE_DAYS);
        }
        await db.collection(COLLECTION).doc(id).set({ status: sub.status, entitledUntil, updatedAt: new Date().toISOString() }, { merge: true });
      }

      if (!entitledUntil || entitledUntil < today) {
        res.status(410).json({ error: 'not entitled', entitledUntil: entitledUntil || null });
        return;
      }
      // 配るキーは「契約の最終日」と「今日+30日」の小さいほう
      const soft = daysFromToday(MAX_OFFLINE_DAYS);
      const expiry = entitledUntil < soft ? entitledUntil : soft;
      res.json({ key: signKey(zpPrivateKey.value(), expiry, id), expiry, status: sub ? sub.status : (d.status || null) });
    } catch (e) {
      console.error('更新に失敗', e);
      res.status(500).json({ error: 'internal error' });
    }
  }
);
