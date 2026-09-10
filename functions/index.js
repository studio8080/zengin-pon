/*
 * 全銀ポン Pro のライセンス発行API（Stripe Webhook + キー更新エンドポイント）
 *
 * なぜサーバーが要るか:
 *   月払いは「解約したら止まる」必要がある。ライセンスキーはオフラインで検証できる署名付きトークンなので、
 *   有効期限を「サブスクの今期末＋猶予5日」にして、支払いのたびに新しいキーを発行し直す。
 *   解約されると次の請求が来ないのでキーは自然に期限切れになる（＝支払った期間の末日までは使える）。
 *
 * 利用者の手間をなくすため、ブラウザは期限が近づくと zenginponLicense を静かに叩いて
 * 新しいキーを取りに行く（送るのはライセンスIDだけ。振込データは一切送らない）。
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
const { licenseIdFor, signKey, expiryFromUnix } = require('./sign');

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
const GRACE_DAYS = 5;          // 期間末を過ぎても数日は使える（更新の行き違い対策）
const ALLOWED_ORIGINS = [SITE, 'http://localhost:8765'];

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
  await transport.sendMail({ from: mailFrom.value(), to, subject, text });
  return true;
}

function keyMail(key, expiry, id, isRenewal) {
  const head = isRenewal
    ? `全銀ポン Proプランを更新しました。新しいライセンスキーをお送りします。\n（サイトを開いていれば自動で更新されるため、多くの場合この作業は不要です。念のための控えです。）`
    : `このたびは全銀ポン Proプランをお申し込みいただき、ありがとうございます。\nライセンスキーをお送りします。`;
  const how = isRenewal ? '' : `
【使い方】
1. ${SITE}/ を開く
2. 「いますぐ変換」の右にある「⭐ Pro」ボタンを押す
3. 上のキーを貼り付けて「有効にする」を押す

これで件数無制限になり、列の割り当ての保存・振込元プロファイル・変換履歴・
バックアップが使えるようになります。会社のPCと自宅のPCなど、2台までご利用いただけます。

【更新について】
月払いの方は、毎月のお支払いのあとにキーが自動で更新されます（サイトを開いたときに
静かに更新されるので、貼り直しは不要です）。うまくいかないときは、このメールのキーを
貼り直してください。
`;
  return `${head}

────────────────────────────
${key}
────────────────────────────

有効期限: ${expiry}
${how}
ご不明な点、取込エラーなどありましたら、このメールにご返信ください。
※ 振込先の一覧やファイルそのものはお送りにならないでください。

--
全銀ポン（ここ企画）
${SITE}/
（ライセンスID: ${id}）`;
}

// ------------------------------------------------------------
// キーの発行と保存
// ------------------------------------------------------------
async function issueForSubscription(stripe, subscription, email, isRenewal) {
  const id = licenseIdFor(subscription.id);
  const periodEnd = subscription.current_period_end
    || (subscription.items && subscription.items.data[0] && subscription.items.data[0].current_period_end);
  if (!periodEnd) throw new Error(`current_period_end が取れません: ${subscription.id}`);
  const expiry = expiryFromUnix(periodEnd, GRACE_DAYS);
  const key = signKey(zpPrivateKey.value(), expiry, id);

  await db.collection(COLLECTION).doc(id).set({
    email: email || null,
    customerId: subscription.customer || null,
    subscriptionId: subscription.id,
    status: subscription.status || 'active',
    expiry,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  if (email) {
    await sendMail(email, isRenewal ? '【全銀ポン】Proプランを更新しました' : '【全銀ポン】Proプランのライセンスキーをお送りします',
      keyMail(key, expiry, id, isRenewal));
  }
  return { id, expiry };
}

async function emailOf(stripe, subscription, fallback) {
  if (fallback) return fallback;
  try {
    const customer = await stripe.customers.retrieve(subscription.customer);
    return (customer && !customer.deleted && customer.email) || null;
  } catch (e) { console.error('顧客のメール取得に失敗', e); return null; }
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
        const email = session.customer_details && session.customer_details.email;
        const r = await issueForSubscription(stripe, sub, await emailOf(stripe, sub, email), false);
        console.log('新規発行', r.id, r.expiry);
      } else if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const subId = invoice.subscription || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
        if (!subId) { res.json({ received: true, skipped: 'no subscription' }); return; }
        if (invoice.billing_reason === 'subscription_create') { res.json({ received: true, skipped: 'initial invoice (handled by checkout)' }); return; }
        const sub = await stripe.subscriptions.retrieve(subId);
        const r = await issueForSubscription(stripe, sub, await emailOf(stripe, sub, invoice.customer_email), true);
        console.log('更新発行', r.id, r.expiry);
      } else if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const id = licenseIdFor(sub.id);
        await db.collection(COLLECTION).doc(id).set({ status: sub.status, updatedAt: new Date().toISOString() }, { merge: true });
        console.log('状態更新', id, sub.status);
      }
      res.json({ received: true });
    } catch (e) {
      console.error('処理に失敗', e);
      res.status(500).send('internal error');
    }
  }
);

// ------------------------------------------------------------
// キー更新エンドポイント（ブラウザが期限前に静かに叩く）
//   GET ?id=<ライセンスID>  →  { key, expiry }
//   送られてくるのはライセンスIDだけ。振込データは一切扱わない。
// ------------------------------------------------------------
exports.zenginponLicense = onRequest(
  { secrets: [zpPrivateKey], region: 'asia-northeast1', cors: false },
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

    try {
      const snap = await db.collection(COLLECTION).doc(id).get();
      if (!snap.exists) { res.status(404).json({ error: 'not found' }); return; }
      const d = snap.data();
      const today = new Date().toISOString().slice(0, 10);
      if (!d.expiry || d.expiry < today) { res.status(410).json({ error: 'expired', expiry: d.expiry || null }); return; }
      // 解約済みでも、支払い済み期間の末日までは使える（expiry がその日付になっている）
      res.set('Cache-Control', 'no-store');
      res.json({ key: signKey(zpPrivateKey.value(), d.expiry, id), expiry: d.expiry, status: d.status || null });
    } catch (e) {
      console.error('更新に失敗', e);
      res.status(500).json({ error: 'internal error' });
    }
  }
);
