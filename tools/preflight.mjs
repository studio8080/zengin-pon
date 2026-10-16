#!/usr/bin/env node
// 出荷前チェック（課金まわり）。ネットワーク・秘密情報なしで、リポジトリのファイルだけを読んで確かめる。
// 有休ポンの tools/preflight.mjs と同じ作りで、項目を全銀ポンに合わせた（商品は Pro の1つ、支払いリンクは config.js）。
//
//   node tools/preflight.mjs          デプロイ前（Functions を出す前・設定を変えたあと）。CI でも実行する
//   node tools/preflight.mjs --sale   販売中であることの確認（支払いリンク2本がそろっているか）
//
// 失敗が1つでもあれば終了コード 1。手順は docs/launch-checklist.md の 3-4「デプロイ前（毎回）」。
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SALE = process.argv.includes('--sale')
const require = createRequire(import.meta.url)
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

const results = []
const ok = (name, detail = '') => results.push({ s: 'ok', name, detail })
const ng = (name, detail = '') => results.push({ s: 'NG', name, detail })
const warn = (name, detail = '') => results.push({ s: '注意', name, detail })
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : ng(name, detail))
const tryRun = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    ng(name, `確認中にエラー: ${e.message}`)
  }
}

const sign = require(path.join(ROOT, 'functions/sign.js'))
const B = require(path.join(ROOT, 'functions/billing.js'))
const License = require(path.join(ROOT, 'src/license.js'))
const indexSrc = read('functions/index.js')
const billingSrc = read('functions/billing.js')
const licenseSrc = read('src/license.js')
const appSrc = read('src/app.js')
const indexHtml = read('index.html')
const pricing = read('pricing.html')
const tokushoho = read('tokushoho.html')
const llms = read('llms.txt')
const buildSite = read('tools/build-site.js')
const cfg = (() => {
  const sandbox = { window: {} }
  vm.runInNewContext(read('config.js'), sandbox)
  return sandbox.window.ZENGIN_CONFIG || {}
})()
const yen = (n) => n.toLocaleString('en-US')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const SIBLING = '../yukyu-pon/functions' // 有休ポン（共用の Stripe アカウントのほかの製品）

// ---------------- 1. 商品ID ----------------
await tryRun('商品ID', () => {
  check(/^prod_[A-Za-z0-9]{8,}$/.test(B.ZP_PRODUCT_ID || ''), 'billing.js: 全銀ポン Pro の商品IDが入っている（空なら Webhook は何もしない）', B.ZP_PRODUCT_ID || '(空)')
  if (exists(`${SIBLING}/plans.js`)) {
    const { PLANS } = require(path.join(ROOT, SIBLING, 'plans.js'))
    const theirs = Object.values(PLANS).map((p) => p.productId).filter(Boolean)
    check(!theirs.includes(B.ZP_PRODUCT_ID), '有休ポンの商品IDと重ならない', theirs.join(' ') || '(有休ポン側は未設定)')
  } else warn('有休ポンの商品IDと照合できない（../yukyu-pon が無い）')
})

// ---------------- 2. 料金と無料の件数 ----------------
await tryRun('料金', () => {
  const m = pricing.match(/data-month="¥([\d,]+)" data-year="¥([\d,]+)"/)
  check(!!m, 'pricing.html の料金（data-month / data-year）を読み取れる')
  const month = Number(m[1].replace(/,/g, ''))
  const year = Number(m[2].replace(/,/g, ''))
  check(tokushoho.includes(`${yen(month)}円`) && tokushoho.includes(`${yen(year)}円`), `tokushoho.html に ${yen(month)}円・${yen(year)}円`)
  check(llms.includes(`${yen(month)}円`) && llms.includes(`${yen(year)}円`), `llms.txt に ${yen(month)}円・${yen(year)}円`)
  check(buildSite.includes(`price: '${month}'`) && buildSite.includes(`price: '${year}'`), `build-site.js の構造化データ（offers）に ${month}・${year}`)
  check(pricing.includes(`${yen(month)}円（税込）`) && pricing.includes(`${yen(year)}円（税込）`), 'pricing.html の確認事項に税込の金額')
  const free = Number((appSrc.match(/const FREE_LIMIT = (\d+);/) || [])[1])
  check(free > 0, 'src/app.js の FREE_LIMIT を読み取れる', String(free))
  check(B.FREE_LINE === `無料プラン（1回${free}件まで）`, `メール文の「無料プラン（1回${free}件まで）」= FREE_LIMIT`, B.FREE_LINE)
  const mail = B.cancelScheduledMail('2026年11月2日') + B.canceledMail()
  check(mail.includes(B.FREE_LINE), '解約受付・終了のメールに無料プランの件数')
  check(pricing.includes(`${free}件まで`) && llms.includes(`${free}件まで`), `pricing.html・llms.txt に「${free}件まで」`)
})

// ---------------- 3. 更新先の URL・CSP・CORS ----------------
await tryRun('URL', () => {
  const api = cfg.LICENSE_API
  const project = JSON.parse(read('.firebaserc')).projects.default
  const fbj = JSON.parse(read('firebase.json'))
  const codebase = (fbj.functions || []).find((f) => f.source === 'functions')
  const expected = `https://${B.REGION}-${project}.cloudfunctions.net/zenginponLicense`
  check(api === expected, 'config.js の LICENSE_API = Functions の URL（リージョン・プロジェクト・関数名）', api)
  check(/exports\.zenginponLicense\s*=/.test(indexSrc) && /exports\.zenginponStripeWebhook\s*=/.test(indexSrc), 'index.js が zenginponLicense・zenginponStripeWebhook を出している（Webhook の URL を変えない）')
  check(codebase && codebase.codebase === 'zenginpon', 'firebase.json の codebase が zenginpon（MiseFits・有休ポンの関数を消さない）')
  check(indexSrc.includes("const COLLECTION = 'zenginponLicenses'"), 'Firestore のコレクション名が zenginponLicenses（既存のお客さまの記録）')
  const csp = indexHtml.match(/connect-src ([^;"]+)[;"]/)
  const origin = api ? new URL(api).origin : ''
  check(csp && csp[1].trim().split(/\s+/).includes(origin), 'index.html の CSP connect-src に更新先がある（消すと有料の人が30日で無料に戻る）', origin)
  const site = `https://${read('CNAME').trim()}`
  check(B.SITE === site, 'billing.js の SITE = CNAME', site)
  check(B.ALLOWED_ORIGINS.includes(site), 'Functions の ALLOWED_ORIGINS に本番のオリジン', B.ALLOWED_ORIGINS.join(' '))
  check(B.ALLOWED_ORIGINS.every((o) => o === site || /^http:\/\/localhost:\d+$/.test(o)), 'ALLOWED_ORIGINS は本番と localhost だけ')
  const pkg = JSON.parse(read('functions/package.json'))
  check(/--only functions:zenginpon\b/.test(pkg.scripts.deploy) && pkg.scripts.deploy.includes(`--project ${project}`), 'functions/package.json の deploy に --only functions:zenginpon と --project', pkg.scripts.deploy)
  for (const s of ['STRIPE_SECRET_KEY', 'ZP_STRIPE_WEBHOOK_SECRET', 'ZP_LICENSE_PRIVATE_KEY', 'SMTP_USER', 'MAIL_FROM', 'SMTP_PASS']) check(indexSrc.includes(`defineSecret('${s}')`), `シークレット ${s} を参照している`)
})

// ---------------- 4. メール ----------------
await tryRun('メール', () => {
  check(B.SENDER_NAME === '全銀ポン（ここ企画）', '差出人名が「全銀ポン（ここ企画）」（共用の MAIL_FROM の表示名を使わない）', B.SENDER_NAME)
  check(JSON.stringify(B.fromHeader('MiseFits <studio@kokokikaku.com>')) === JSON.stringify({ name: B.SENDER_NAME, address: 'studio@kokokikaku.com' }), 'MAIL_FROM からアドレスだけ取り出す')
  check(/^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9]+$/.test(B.PORTAL_URL), 'PORTAL_URL がカスタマーポータルのログインリンク', B.PORTAL_URL)
  if (exists(`${SIBLING}/billing.js`)) {
    const Y = require(path.join(ROOT, SIBLING, 'billing.js'))
    // 有休ポンは専用ポータルで4価格を切り替える。共用リンクへの戻しを防ぐ。
    check(Y.PORTAL_URL !== B.PORTAL_URL, 'PORTAL_URL が有休ポン専用のリンクと別（商品ごとのプラン切り替え先を維持）', B.PORTAL_URL)
  } else warn('PORTAL_URL を有休ポンと照合できない（../yukyu-pon が無い）')
  const bodies = {
    キー: B.welcomeMail('ZP1-abc.def', 'Emn4w-UX3Ygb', '年払い'),
    更新: B.renewalMail('ZP1-abc.def', '2026-11-14', 'Emn4w-UX3Ygb'),
    解約受付: B.cancelScheduledMail('2026年11月2日'),
    終了: B.canceledMail(),
    運営者: B.operatorMail('テスト', { a: 1 }, 'ZP1-abc.def'),
  }
  for (const [k, text] of Object.entries(bodies)) {
    check(!text.includes('**') && !/^#{1,6} /m.test(text) && !/\[[^\]]+\]\(http/.test(text), `メール（${k}）はプレーンテキスト（Markdown なし）`)
    check(!/undefined|null|NaN|\$\{/.test(text), `メール（${k}）に埋め込み漏れがない`)
  }
  check(bodies.キー.includes(`${B.SITE}/#pro`) && bodies.キー.includes(B.PORTAL_URL), 'キーのメールに /#pro と契約の管理ページ')
  check(!bodies.キー.includes('領収書メール'), 'キーのメールに「領収書メールから解約」と書かない（2026-10-02 の点検）')
  check(bodies.解約受付.includes(B.PORTAL_URL), '解約受付のメールに契約の管理ページ（取り消し用）')
  check(!/\*\*/.test(stripComments(indexSrc)) && !/\*\*/.test(stripComments(billingSrc)), 'index.js・billing.js の文字列に ** が無い')
})

// ---------------- 5. キーの形式（公開鍵・署名・接頭辞） ----------------
await tryRun('キー', async () => {
  const pub = License.PUBLIC_KEY
  check(/^[A-Za-z0-9_-]{43}$/.test(pub || '') && Buffer.from(pub, 'base64url').length === 32, 'license.js の PUBLIC_KEY が Ed25519 の生32バイト（base64url）', pub)
  let pubKey = null
  try {
    pubKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' })
  } catch {
    /* 下で NG */
  }
  check(!!pubKey, 'PUBLIC_KEY を Ed25519 の公開鍵として読み込める')
  // 使い捨ての鍵で sign.js のキーを作り、ブラウザの license.js が読めるか（同じ検証の処理を使う）
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const id = sign.licenseIdFor('sub_preflight')
  const key = sign.signKey(pem, '2099-01-31', id)
  check(/^ZP1-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key), 'sign.js のキーが ZP1-<base64url>.<base64url>（既存のお客さまのキーと同じ形式）', key.slice(0, 16) + '…')
  const [, body] = key.match(/^ZP1-([^.]+)\./)
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  check(JSON.stringify(Object.keys(payload)) === JSON.stringify(['v', 'p', 'e', 'id']) && payload.v === 1 && payload.p === 'pro' && payload.e === '2099-01-31' && payload.id === id, 'キーの中身が { v:1, p:"pro", e, id }')
  const v = await License._withPublicKey(publicKey.export({ format: 'jwk' }).x).verify(key, '2026-01-01')
  check(v.ok && v.payload.id === id, 'sign.js のキーを license.js の verify が通す（使い捨ての鍵）', v.reason || '')
  const vp = await License.verify(key, '2026-01-01')
  check(!vp.ok, '本番の公開鍵は使い捨ての鍵の署名を通さない')
  check(id === crypto.createHash('sha256').update('sub_preflight').digest('base64url').slice(0, 12), 'ライセンスIDの作り方が従来どおり（sha256(契約ID) の base64url 先頭12文字）')
  const idRe = '/^[A-Za-z0-9_-]{6,32}$/'
  check(/^[A-Za-z0-9_-]{6,32}$/.test(id) && indexSrc.includes(idRe) && licenseSrc.includes(idRe), 'ライセンスIDがキー更新エンドポイント・ブラウザの受け付ける形')
  check(licenseSrc.includes("STORAGE = 'zenginpon.license'") && licenseSrc.includes("LAST_CHECK = 'zenginpon.licenseChecked'"), 'ブラウザの保存キー（zenginpon.license / zenginpon.licenseChecked）が従来どおり')
})

// ---------------- 6. 支払いリンク ----------------
await tryRun('支払いリンク', () => {
  const links = [cfg.STRIPE_LINK_MONTH, cfg.STRIPE_LINK_YEAR]
  const live = links.filter((l) => /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/.test(l || ''))
  if (live.length === 2) {
    check(links[0] !== links[1], '支払いリンク（月払い・年払い）が別の URL', links.join(' '))
    ok('支払いリンク: 2本とも buy.stripe.com（販売中）')
  } else if (links.every((l) => !l)) {
    ;(SALE ? ng : warn)('支払いリンク: 2本とも空（料金ページは「準備中」。販売を止めている状態）')
  } else {
    ng('支払いリンク: 空と販売中が混ざっている、または buy.stripe.com でない', links.join(' '))
  }
})

// ---------------- 7. 秘密情報がリポジトリに入っていない ----------------
await tryRun('秘密情報', () => {
  const gi = read('.gitignore')
  for (const p of ['*.pem', 'functions/.env', 'tools/issued-keys.csv']) check(gi.split(/\r?\n/).includes(p), `.gitignore に ${p}`)
  const hits = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.claude'].includes(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs|ts|json|html|md|txt|yml|yaml|env|pem)$/.test(e.name) && fs.statSync(p).size < 2_000_000) {
        const s = fs.readFileSync(p, 'utf8')
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|rk)_live_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{20,}/.test(s)) hits.push(path.relative(ROOT, p))
      }
    }
  }
  walk(ROOT)
  check(hits.length === 0, '秘密鍵・Stripe の本番キー・Webhook の署名シークレットがファイルに無い', hits.join(' '))
})

// ---------------- 結果 ----------------
const width = Math.max(...results.map((r) => r.s.length))
for (const r of results) console.log(`${r.s.padEnd(width)}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
const failed = results.filter((r) => r.s === 'NG').length
const warned = results.filter((r) => r.s === '注意').length
console.log(`\n${SALE ? '販売中' : 'デプロイ前'}のチェック: ${results.length - failed - warned} ok / ${warned} 注意 / ${failed} NG`)
console.log('ネットワークを使う確認（Stripe の Webhook の API バージョン・イベント4件・制限付きキーの権限）は docs/launch-checklist.md の手順で人が見る。')
process.exit(failed ? 1 : 0)
