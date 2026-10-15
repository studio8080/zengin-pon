/*
 * 全銀ポン Pro のライセンス発行API（Stripe Webhook + キー更新エンドポイント）
 * 判定とメールの文面は billing.js（外部モジュールなし。テストと tools/preflight.mjs からも読む）。
 * 有休ポン（studio8080/yukyu-pon の functions/）と同じ設計（2026-10-15 にそろえた）。
 *
 * 方針:
 *   月払いも年払いも Stripe のサブスクリプション（自動更新）。
 *   ライセンスキーはオフラインで検証できる署名付きトークンなので、そのままだと解約しても
 *   期限まで使えてしまう。そこで **キーの寿命を短く（既定30日）** して、ブラウザが定期的に
 *   取り直す設計にした。取り直すたびに Stripe の契約状態を見に行くので、
 *
 *     - 契約中        → 期限を「今日+30日」まで延ばして返す（年払いでも同じ。利用者は気づかない）
 *     - 解約・未払い  → 410 を返す。ブラウザは保存済みのキーを削除して Free に戻る
 *     - 期間末で解約  → 期間の末日（日付指定ならその日）+猶予までは延ばすが、それ以上は延ばさない → 自然に失効
 *     - Stripe に照会できず、手元の記録でも判断できない → 503（ブラウザは何もしない。キーを消さない）
 *
 *   使ってよい最終日は契約の状態で決める（billing.js の entitledUntilOf）。
 *   完全にオフラインで使い続けた場合でも、手元のキーは最長30日で切れる。
 *
 * Webhook は二重に届く・同時に届く・途中で落ちる前提で書く（共通メモ5章の4）:
 *   イベントID（zenginponEvents）で先に枠を取り（create）、完了したら doneAt、メールを送ったら mailedAt。
 *   同時到着は 409、失敗したら処理中の印を外して 500 → Stripe が再送する。メールを送れないときも 500。
 *
 * 置き場所:
 *   既存の Firebase プロジェクト "misefits"（Blaze 設定済み）に codebase "zenginpon" として相乗りする。
 *   codebase を分けているので、ここから deploy しても Misefits・有休ポンの関数は消えない。
 *   デプロイは必ず --only functions:zenginpon を付ける。
 *   Firestore のルールはこのリポジトリからは配らない（firebase.json に firestore を書いていない）。
 *
 * 必要なシークレット（Secret Manager）:
 *   STRIPE_SECRET_KEY         … Misefits と共通の制限付きキー。Subscriptions・Customers の読み取りが必須
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
const { licenseIdFor, signKey } = require('./sign');
const B = require('./billing');

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

// コレクション名・フィールド名は既存のお客さまの記録と同じものを使い続ける（変えない）
const COLLECTION = 'zenginponLicenses';
const EVENTS = 'zenginponEvents';
const HANDLED = ['checkout.session.completed', 'invoice.paid', 'customer.subscription.updated', 'customer.subscription.deleted'];
const LEASE_SECONDS = 120; // 同じイベントを同時に処理しない（関数のタイムアウト60秒より長く）
const RECHECK_SECONDS = 600; // キー更新で、この間に Stripe で確かめていれば照会を省く（連打で共用の Stripe の上限を使わない）

const licenseRef = (id) => db.collection(COLLECTION).doc(id);
async function readLicense(id) {
  const snap = await licenseRef(id).get();
  return snap.exists ? snap.data() || {} : null;
}

// ------------------------------------------------------------
// メール（プレーンテキスト。Markdown を書かない。文面は billing.js）
// ------------------------------------------------------------
function mailerReady() {
  return !!(smtpHost.value() && smtpUser.value() && mailFrom.value() && smtpPass.value());
}
const operatorAddress = () => B.fromHeader(mailFrom.value()).address;

async function sendMail(to, subject, text) {
  if (!mailerReady()) {
    console.error('SMTP 未設定のためメールを送れません（運営者が手動で送ること）:', to, subject);
    return false;
  }
  const transport = nodemailer.createTransport({
    host: smtpHost.value(), port: Number(smtpPort.value()), secure: Number(smtpPort.value()) === 465,
    auth: { user: smtpUser.value(), pass: smtpPass.value() },
  });
  const from = B.fromHeader(mailFrom.value());
  try {
    await transport.sendMail({ from, to, subject, text });
    return true;
  } catch (e) {
    console.error('メール送信に失敗', to, subject, e.message);
    // 送れなかったことを運営者に知らせる（これも失敗したらログだけ）
    try {
      await transport.sendMail({ from, to: from.address, subject: `【要対応】全銀ポンのメールを送れませんでした: ${subject}`, text: `宛先: ${to}\n件名: ${subject}\nエラー: ${e.message}\n\n本文:\n${text}` });
    } catch (e2) {
      console.error('運営者への通知にも失敗', e2.message);
    }
    return false;
  }
}

/**
 * 購入者のメールアドレス。分かっている値（イベント・Firestore）を先に使い、無ければ Stripe の顧客を見る。
 * 顧客が削除済み・存在しないなら null。権限不足など、それ以外の失敗は投げて 500 にし、Stripe に再送させる
 * （2026-10-02 の障害: 制限付きキーに読み取り権限が無かった。黙って null にすると気づけない）。
 */
async function emailOf(stripe, sub, ...known) {
  for (const k of known) if (k) return k;
  const cid = B.customerIdOf(sub);
  if (!cid) return null;
  let customer;
  try {
    customer = await stripe.customers.retrieve(cid);
  } catch (e) {
    if (e && (e.code === 'resource_missing' || e.statusCode === 404)) return null;
    throw e;
  }
  return (customer && !customer.deleted && customer.email) || null;
}

/**
 * 契約状態を Firestore に保存する。分かっている値（メールなど）を null で上書きしない。
 * live = Stripe に今照会した値か（Webhook の中身はその時点の写しで、順番が前後して届くことがある）。
 */
async function saveState(sub, email, live) {
  const id = licenseIdFor(sub.id);
  const entitledUntil = B.entitledUntilOf(sub);
  const now = new Date().toISOString();
  await licenseRef(id).set({
    ...(email ? { email } : {}),
    ...(B.customerIdOf(sub) ? { customerId: B.customerIdOf(sub) } : {}),
    subscriptionId: sub.id,
    status: sub.status || 'active',
    // 契約として使える最終日（ここが上限。キーの期限はこれと30日先の小さいほう）。使えない契約は null
    entitledUntil,
    stripeCheckedAt: live ? now : null,
    updatedAt: now,
  }, { merge: true });
  return { id, entitledUntil };
}

/** 実際に配るキーを作る */
function makeKey(entitledUntil, id) {
  const expiry = B.keyExpiry(entitledUntil);
  return { key: signKey(zpPrivateKey.value(), expiry, id), expiry };
}

/**
 * Webhook の二重配信・同時到着・途中で落ちた再送への備え。
 * イベントIDで先に枠を取る（create）。もう完了していれば何もしない。ほかの処理が実行中（leaseUntil 内）なら 409 で後から再送させる。
 * 途中で落ちていた（done でない）なら続きから。メールは送ったら印を付け、再送で二重に送らない。
 * 印の無い古い形の記録（leaseUntil・doneAt が無い）は「途中で落ちた」として続きから処理する。
 */
async function claimEvent(eventId, type) {
  const ref = db.collection(EVENTS).doc(eventId);
  const now = Date.now();
  try {
    await ref.create({ type, startedAt: new Date(now).toISOString(), leaseUntil: now + LEASE_SECONDS * 1000 });
    return { ref, done: false, busy: false, mailed: false };
  } catch (e) {
    if (e.code !== 6 && e.code !== 'already-exists' && !/ALREADY_EXISTS/.test(String(e.message))) throw e;
    const snap = await ref.get();
    const d = (snap.exists && snap.data()) || {};
    if (d.doneAt) return { ref, done: true };
    if (d.leaseUntil && d.leaseUntil > now) return { ref, busy: true };
    await ref.set({ leaseUntil: now + LEASE_SECONDS * 1000, retriedAt: new Date(now).toISOString() }, { merge: true });
    return { ref, done: false, busy: false, mailed: !!d.mailedAt };
  }
}

// ------------------------------------------------------------
// Stripe Webhook
// ------------------------------------------------------------
exports.zenginponStripeWebhook = onRequest(
  { secrets: [stripeSecretKey, zpWebhookSecret, zpPrivateKey, smtpUser, mailFrom, smtpPass], region: B.REGION, maxInstances: 5, timeoutSeconds: 60 },
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
    if (!B.ZP_PRODUCT_ID) {
      // 共用アカウントなので、商品で絞れないときは全部通すのではなく止める（共通メモ5章の3）
      console.error('全銀ポンの商品IDが未設定のため処理しません');
      res.json({ received: true, skipped: 'not configured' });
      return;
    }
    // 共用アカウントのほかの製品（MiseFits・有休ポン）のイベントは、Firestore にも Stripe にも触らずに返す
    const obj = event.data && event.data.object;
    if (!HANDLED.includes(event.type)) return void res.json({ received: true, skipped: 'unhandled type' });
    if (event.type.startsWith('customer.subscription.') && !B.isZenginPon(obj)) return void res.json({ received: true, skipped: 'other product' });
    if (event.type === 'invoice.paid' && B.isOtherProductInvoice(obj)) return void res.json({ received: true, skipped: 'other product' });

    let claim = null;
    try {
      claim = await claimEvent(event.id, event.type);
      if (claim.done) return void res.json({ received: true, skipped: 'already processed' });
      if (claim.busy) return void res.status(409).json({ error: 'in progress' });
      // 送れなかったら 500 を返して Stripe に再送させる（Stripe は最長3日再送し、失敗が続くと運営者にも知らせる）
      const mailOnce = async (to, subject, text) => {
        if (!to || claim.mailed) return;
        if (!(await sendMail(to, subject, text))) throw new Error(`メールを送れませんでした: ${subject}`);
        claim.mailed = true;
        await claim.ref.set({ mailedAt: new Date().toISOString() }, { merge: true });
      };
      const notifyOperator = (subject, what, fields, key) => mailOnce(operatorAddress(), `【要対応】全銀ポン: ${subject}`, B.operatorMail(what, fields, key));
      const finish = async (body) => {
        await claim.ref.set({ doneAt: new Date().toISOString(), leaseUntil: 0 }, { merge: true });
        res.json({ received: true, ...body });
      };

      if (event.type === 'checkout.session.completed') {
        const session = obj;
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription && session.subscription.id;
        if (session.mode !== 'subscription' || !subId) return finish({ skipped: 'not a subscription' });
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!B.isZenginPon(sub)) return finish({ skipped: 'other product' });
        const email = await emailOf(stripe, sub, session.customer_details && session.customer_details.email, session.customer_email);
        const { id, entitledUntil } = await saveState(sub, email, true);
        const fields = { ライセンスID: id, 契約: sub.id, 顧客: B.customerIdOf(sub), 状態: sub.status, イベント: event.id };
        if (!entitledUntil || entitledUntil < B.todayIso()) {
          await notifyOperator('申し込みの契約が有効になっていません', '申し込みは完了しましたが、契約が支払い済みの状態ではないため、キーを送っていません。', fields);
          return finish({ skipped: 'not entitled' });
        }
        const { key, expiry } = makeKey(entitledUntil, id);
        if (email) await mailOnce(email, '【全銀ポン】Proプランのライセンスキーをお送りします', B.welcomeMail(key, id, B.planLabelOf(sub)));
        else await notifyOperator('キーを送れませんでした（メールアドレスが分かりません）', '購入者のメールアドレスが分からないため、キーを送れませんでした。顧客のメールアドレスを確かめて、下のキーを送ってください。', fields, key);
        console.log('新規発行', id, expiry);
        return finish({});
      }

      if (event.type === 'invoice.paid') {
        const invoice = obj;
        const subId = B.subscriptionIdOfInvoice(invoice);
        if (!subId) return finish({ skipped: 'no subscription' });
        // 初回はチェックアウト完了でキーを送るので、ここでは送らない（二重に送らない）
        if (invoice.billing_reason === 'subscription_create') return finish({ skipped: 'initial invoice (handled by checkout)' });
        const sub = await stripe.subscriptions.retrieve(subId);
        if (!B.isZenginPon(sub)) return finish({ skipped: 'other product' });
        const stored = await readLicense(licenseIdFor(sub.id));
        const email = await emailOf(stripe, sub, invoice.customer_email, stored && stored.email);
        const { id, entitledUntil } = await saveState(sub, email, true);
        if (!entitledUntil || entitledUntil < B.todayIso()) return finish({ skipped: 'not entitled' });
        const { key, expiry } = makeKey(entitledUntil, id);
        if (email) await mailOnce(email, '【全銀ポン】Proプランを更新しました', B.renewalMail(key, expiry, id));
        else await notifyOperator(
          '更新のキーの控えを送れませんでした（メールアドレスが分かりません）',
          '更新の支払いを確認しましたが、購入者のメールアドレスが分かりません（キーはブラウザで自動更新されるので、急ぎではありません）。',
          { ライセンスID: id, 契約: sub.id, 顧客: B.customerIdOf(sub), イベント: event.id },
          key,
        );
        console.log('更新発行', id, expiry);
        return finish({});
      }

      if (event.type === 'customer.subscription.deleted') {
        // 即時解約なら ended_at が「今」。期間末解約なら ended_at は期間の末日。
        const sub = obj;
        const id = licenseIdFor(sub.id);
        const stored = await readLicense(id);
        const { entitledUntil } = await saveState({ ...sub, status: sub.status || 'canceled' }, null, false);
        if (stored && stored.email) await mailOnce(stored.email, '【全銀ポン】Proプランのご契約が終了しました', B.canceledMail());
        else console.warn('契約の記録（メールアドレス）が無い解約。終了のメールは送っていません', id, sub.id);
        console.log('解約', id, entitledUntil);
        return finish({});
      }

      // customer.subscription.updated
      const sub = obj;
      const id = licenseIdFor(sub.id);
      const stored = await readLicense(id);
      // 解約済みの記録を、順番が前後して届いた古い写しで「契約中」に戻さない（解約した契約は再開できない）
      if (stored && B.TERMINAL.includes(stored.status) && !B.TERMINAL.includes(sub.status)) return finish({ skipped: 'stale (already ended)' });
      await saveState(sub, null, false);
      // 解約の予約（期間の末日や指定日で終わる）を受け付けた瞬間に、いつまで使えるかを知らせる。
      // subscription.deleted は期間の末日に届くので、そこで「承りました」と送ると遅すぎる。
      const prev = (event.data && event.data.previous_attributes) || {};
      const nowScheduled = !!(sub.cancel_at_period_end || sub.cancel_at);
      const wasScheduled = ('cancel_at_period_end' in prev || 'cancel_at' in prev) ? !!(prev.cancel_at_period_end || prev.cancel_at) : nowScheduled;
      if (nowScheduled && !wasScheduled && sub.status !== 'canceled') {
        const end = sub.cancel_at || B.periodEndOf(sub);
        if (end) await mailOnce(stored && stored.email, '【全銀ポン】Proプランの解約を承りました', B.cancelScheduledMail(B.jstDate(end)));
      }
      console.log('状態更新', id, sub.status, nowScheduled ? '解約予約あり' : '');
      return finish({});
    } catch (e) {
      console.error('処理に失敗', e);
      // すぐに再送できるように、実行中の印を外す（外せなくても LEASE_SECONDS で切れる）
      if (claim && claim.ref) await claim.ref.set({ leaseUntil: 0, lastError: String(e && e.message) }, { merge: true }).catch(() => {});
      res.status(500).send('internal error');
    }
  }
);

// ------------------------------------------------------------
// キー更新エンドポイント（ブラウザが定期的に叩く）
//   GET ?id=<ライセンスID>
//     200 { key, expiry, status }  … 契約中
//     410 { error }        … Stripe（照会か署名付き Webhook）で解約・期限切れを確かめた（ブラウザは保存済みキーを消す）
//     503 { error }        … Stripe に照会できず、手元の記録でも判断できない（ブラウザは何もしない）
//     404                  … 自動発行の記録が無い（手動発行のキー）
//   送られてくるのはライセンスIDだけ。振込データは一切扱わない。
// ------------------------------------------------------------
exports.zenginponLicense = onRequest(
  { secrets: [stripeSecretKey, zpPrivateKey], region: B.REGION, cors: false, maxInstances: 10, timeoutSeconds: 30 },
  async (req, res) => {
    const origin = req.headers.origin;
    if (origin && B.ALLOWED_ORIGINS.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods', 'GET'); res.status(204).send(''); return; }
    if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }

    const id = String(req.query.id || '');
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
    res.set('Cache-Control', 'no-store');

    try {
      const d = await readLicense(id);
      if (!d) { res.status(404).json({ error: 'not found' }); return; }
      const today = B.todayIso();
      let entitledUntil = d.entitledUntil || null;
      let status = d.status || null;
      // Stripe で確かめた状態か。Webhook（Stripe の署名付き）で解約を受け取っていれば確定
      let confirmed = B.TERMINAL.includes(status);
      const fresh = !!d.stripeCheckedAt && Date.now() - Date.parse(d.stripeCheckedAt) < RECHECK_SECONDS * 1000;

      if (fresh) {
        confirmed = true;
      } else {
        // Stripe に現在の契約状態を直接確認する（Webhook の取りこぼしがあっても正しく判定できる）
        let sub = null;
        try {
          sub = await new Stripe(stripeSecretKey.value()).subscriptions.retrieve(d.subscriptionId);
        } catch (e) {
          console.error('Stripe 参照に失敗、Firestore の値で判定します', id, e.message);
        }
        if (sub) {
          entitledUntil = B.entitledUntilOf(sub);
          status = sub.status;
          confirmed = true;
          const now = new Date().toISOString();
          await licenseRef(id)
            .set({ status, entitledUntil, stripeCheckedAt: now, updatedAt: now }, { merge: true })
            .catch((e) => console.error('Firestore への保存に失敗（応答は続ける）', id, e.message));
        }
      }

      if (!entitledUntil || entitledUntil < today) {
        if (confirmed) {
          res.status(410).json({ error: 'not entitled', entitledUntil: entitledUntil || null });
        } else {
          // 解約を確かめられないうちはキーを消させない（ブラウザは手元のキーの期限まで使い、次に開いたときに取り直す）
          res.set('Retry-After', '3600');
          res.status(503).json({ error: 'temporarily unavailable' });
        }
        return;
      }
      // 配るキーは「契約の最終日」と「今日+30日」の小さいほう
      const expiry = B.keyExpiry(entitledUntil);
      res.json({ key: signKey(zpPrivateKey.value(), expiry, id), expiry, status });
    } catch (e) {
      console.error('更新に失敗', e);
      res.status(500).json({ error: 'internal error' });
    }
  }
);
