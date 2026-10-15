/*
 * billing.js — 契約の判定とメールの文面（外部モジュールを使わない純粋な処理）
 * index.js（Cloud Functions）・test/functions.test.js・tools/preflight.mjs から使う。
 * 有休ポン（studio8080/yukyu-pon の functions/billing.js）と同じ設計。違いは商品が1つ（Pro）だけなこと。
 *
 * Stripe の形の違いに備える:
 *   - API 2025-03-31.basil 以降、契約期間（current_period_start / end）はサブスクリプション直下から
 *     items.data[] に移った。Webhook（2026-08-26.dahlia）も SDK の照会（stripe-node 18.5 = 2025-08-27.basil）も items 側。
 *     古い形（直下）でも動くように両方を見る。
 *   - 請求書の subscription は basil 以降 parent.subscription_details.subscription。古い形は invoice.subscription。
 *   - 請求書の明細の商品は basil 以降 lines.data[].pricing.price_details.product。古い形は lines.data[].price.product。
 *   - 期間末の解約は cancel_at_period_end のほか、flexible billing では cancel_at（日時）で表されることがある。
 */
const { expiryFromUnix, daysFromToday } = require('./sign');

const SITE = 'https://zenginpon.kokokikaku.com';
const ALLOWED_ORIGINS = [SITE, 'http://localhost:8877'];
// Stripe アカウントは MiseFits / MenuFits / 有休ポンと共用。全銀ポン Pro 以外の契約にはキーを出さない。
const ZP_PRODUCT_ID = 'prod_VEa5100IEJu6JE';
// Stripe カスタマーポータルのログインリンク（設定 → Billing → カスタマーポータル → 「リンクを有効化」で発行。アカウント共通）。
// 空のあいだは「メールへの返信で解約」と案内する。
const PORTAL_URL = 'https://billing.stripe.com/p/login/cNi7sEb0eg2g7HtcOv9R600';
// MAIL_FROM は MiseFits と共用（「MiseFits <studio@…>」）。アドレスだけ使い、表示名は全銀ポンにする。
// 共用の値を書き換えると MiseFits のメールの差出人が変わるので、こちらで差し替える。
const SENDER_NAME = '全銀ポン（ここ企画）';
const REGION = 'asia-northeast1';

const GRACE_DAYS = 3; // 契約期間の末日を過ぎても数日は使える（更新の行き違い対策）
const MAX_OFFLINE_DAYS = 30; // キーの最長寿命。これを超える期限は発行しない
// 再請求中（past_due）でも使わせる上限。今の期間の初日から数える。
// Stripe 側は「再試行がすべて失敗したらキャンセル」（launch-checklist 4章）なので通常はそちらで終わる。設定が変わったときの保険。
const PAST_DUE_DAYS = 30;
// 状態が「もう戻らない」もの。Webhook（Stripe の署名付き）でこれを受け取っていれば、Stripe に照会できなくても失効させてよい
const TERMINAL = ['canceled', 'incomplete_expired'];

const idOf = (v) => (typeof v === 'string' ? v : v && v.id) || null;
const firstItem = (sub) => (sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0]) || null;

/** 全銀ポン Pro の契約か（同じ Stripe アカウントのほかの商品を誤って処理しない。商品IDが空なら false） */
function isZenginPon(subscription) {
  if (!ZP_PRODUCT_ID) return false;
  const items = (subscription && subscription.items && subscription.items.data) || [];
  return items.some((it) => (idOf(it.price && it.price.product) || idOf(it.plan && it.plan.product)) === ZP_PRODUCT_ID);
}

/** 契約期間の末日（Unix秒）。新しい形は items.data[].current_period_end、古い形は直下 */
function periodEndOf(sub) {
  const it = firstItem(sub);
  return (it && it.current_period_end) || sub.current_period_end || null;
}

/** 契約期間の初日（Unix秒） */
function periodStartOf(sub) {
  const it = firstItem(sub);
  return (it && it.current_period_start) || sub.current_period_start || null;
}

function planLabelOf(sub) {
  const it = firstItem(sub);
  const interval = it && it.price && it.price.recurring && it.price.recurring.interval;
  return interval === 'year' ? '年払い' : '月払い';
}

const customerIdOf = (sub) => idOf(sub && sub.customer);

/** 請求書の契約ID（新旧どちらの形でも） */
function subscriptionIdOfInvoice(invoice) {
  const parent = invoice && invoice.parent;
  return idOf(invoice && invoice.subscription) || idOf(parent && parent.subscription_details && parent.subscription_details.subscription) || null;
}

/**
 * 請求書の明細の商品ID。明細が全部そろっていて全部読めたときだけ配列を返す（分からなければ null = 照会して確かめる）。
 * ほかの製品（MiseFits・有休ポン）の請求書に Stripe の照会をしないため。
 */
function invoiceProductIds(invoice) {
  const lines = invoice && invoice.lines;
  if (!lines || !Array.isArray(lines.data) || !lines.data.length || lines.has_more) return null;
  const ids = [];
  for (const l of lines.data) {
    const pd = l.pricing && l.pricing.price_details;
    const pid = idOf(pd && pd.product) || idOf(l.price && l.price.product) || idOf(l.plan && l.plan.product);
    if (!pid) return null;
    ids.push(pid);
  }
  return ids;
}

/** 明細から、全銀ポンの商品が含まれないと分かる請求書か */
function isOtherProductInvoice(invoice) {
  const ids = invoiceProductIds(invoice);
  if (!ids) return false;
  return !ids.includes(ZP_PRODUCT_ID);
}

/**
 * この契約で使ってよい最終日（'YYYY-MM-DD'、猶予込み）。使えない契約は null。
 *   active / trialing … 期間の末日（日付指定の解約 cancel_at が先ならそちら）
 *   past_due          … 期間の末日と「期間の初日 + PAST_DUE_DAYS」の早いほう
 *   canceled          … 終わった日（ended_at）
 *   unpaid / paused   … 支払い済みなのは今の期間の初日まで
 *   incomplete / incomplete_expired … 一度も支払われていない → null
 */
function entitledUntilOf(sub) {
  const status = sub.status || 'active';
  const start = periodStartOf(sub);
  let end = periodEndOf(sub);
  if (sub.cancel_at && (!end || sub.cancel_at < end)) end = sub.cancel_at;
  switch (status) {
    case 'active':
    case 'trialing':
      break;
    case 'past_due':
      if (start) end = Math.min(end || Infinity, start + PAST_DUE_DAYS * 86400);
      break;
    case 'canceled':
      end = sub.ended_at || sub.canceled_at || end;
      break;
    case 'unpaid':
    case 'paused':
      end = start || null;
      break;
    default:
      return null;
  }
  return end ? expiryFromUnix(end, GRACE_DAYS) : null;
}

/** 実際に配るキーの期限: min(使ってよい最終日, 今日 + MAX_OFFLINE_DAYS) */
function keyExpiry(entitledUntil) {
  const soft = daysFromToday(MAX_OFFLINE_DAYS);
  return entitledUntil < soft ? entitledUntil : soft;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------
// メール（プレーンテキスト。Markdown を書かない）
// ------------------------------------------------------------
function fromHeader(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  return { name: SENDER_NAME, address: m ? m[1] : s };
}

/** Unix秒 → 日本時間の「2026年11月2日」 */
function jstDate(unix) {
  const d = new Date((Number(unix) + 9 * 3600) * 1000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

const FREE_LINE = '無料プラン（1回20件まで）';

function cancelHow() {
  return PORTAL_URL
    ? `次のページから、ご登録のメールアドレスでいつでも解約できます（このメールへのご返信でも承ります）。
${PORTAL_URL}`
    : 'このメールにご返信いただければ、解約を承ります（いつでも可能です）。';
}

function welcomeMail(key, id, planLabel) {
  return `このたびは全銀ポン Proプラン（${planLabel}）をお申し込みいただき、ありがとうございます。
ライセンスキーをお送りします。

────────────────────────────
${key}
────────────────────────────

【使い方】
1. 次のリンクを開くと、キーの入力画面が開きます
   ${SITE}/#pro
   （開かないときは、${SITE}/ の「いますぐ変換」の右にある「⭐ Pro のキーを入力」を押してください）
2. 上のキーを貼り付けて「有効にする」を押す

これで件数無制限になり、列の割り当ての保存・振込元プロファイル・変換履歴・
バックアップが使えるようになります。会社のPCと自宅のPCなど、2台までご利用いただけます。

【キーの有効期限について】
キーには短い有効期限が入っていますが、ご契約が続いているかぎり、サイトを開いたときに
自動で更新されます（貼り直しの必要はありません）。ご契約は自動更新のため、
解約のお手続きをされない限り、そのままお使いいただけます。

うまく更新されないときは「⭐ Pro 有効」ボタンを押して「更新を確認」を押してください。
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

/** 解約の手続きを受け付けたとき（期間の末日や指定日で終わる予約） */
function cancelScheduledMail(endDate) {
  return `全銀ポン Proプランの解約を承りました。

${endDate} までは、これまでどおり Pro の機能をご利用いただけます。
その後は自動的に${FREE_LINE}に戻ります。お手続きは不要です。
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

${FREE_LINE}は、これまでどおりお使いいただけます。
作成済みの設定やデータは、このブラウザに残っています。

またのご利用をお待ちしています。ご不便な点がありましたら、
このメールにご返信いただけると今後の改善に役立ちます。

--
全銀ポン（ここ企画）
${SITE}/`;
}

/** 運営者あての「要対応」（購入者のメールアドレスが分からない・契約が有効でない など） */
function operatorMail(what, fields, key) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return `${what}

${lines.join('\n')}
${key ? `\n発行したキー（購入者に手動で送る）:\n${key}\n` : ''}
Stripe のダッシュボードで顧客と契約を確かめてください。手順は docs/launch-checklist.md の3-4・4章。
（全銀ポンの Cloud Functions から自動で送っています）`;
}

module.exports = {
  SITE,
  ALLOWED_ORIGINS,
  ZP_PRODUCT_ID,
  PORTAL_URL,
  SENDER_NAME,
  REGION,
  GRACE_DAYS,
  MAX_OFFLINE_DAYS,
  PAST_DUE_DAYS,
  TERMINAL,
  FREE_LINE,
  isZenginPon,
  periodEndOf,
  periodStartOf,
  planLabelOf,
  customerIdOf,
  subscriptionIdOfInvoice,
  invoiceProductIds,
  isOtherProductInvoice,
  entitledUntilOf,
  keyExpiry,
  todayIso,
  fromHeader,
  jstDate,
  welcomeMail,
  renewalMail,
  cancelScheduledMail,
  canceledMail,
  operatorMail,
};
