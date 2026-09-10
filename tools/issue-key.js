#!/usr/bin/env node
/*
 * Pro ライセンスキーの発行（手動運用でも Stripe Webhook からでも使える）
 *
 *   node tools/issue-key.js --months 12            年払い（今日から12か月）
 *   node tools/issue-key.js --months 1             月払い（今日から1か月）
 *   node tools/issue-key.js --until 2027-03-31     期限を直接指定
 *   node tools/issue-key.js --months 12 --id ord_123   発行IDを指定（Stripe の注文IDなど。既定はランダム）
 *
 * 秘密鍵は 環境変数 ZP_PRIVATE_KEY（PEM文字列）か、ZP_PRIVATE_KEY_FILE（既定: ~/.zengin-pon/license-private.pem）から読む。
 * 出力されたキーを購入者にメールで送る。台帳（誰にいつ何を発行したか）は tools/issued-keys.csv に追記する（gitignore 済み）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const pemFile = process.env.ZP_PRIVATE_KEY_FILE || path.join(os.homedir(), '.zengin-pon', 'license-private.pem');
const pem = process.env.ZP_PRIVATE_KEY || (fs.existsSync(pemFile) ? fs.readFileSync(pemFile, 'utf8') : null);
if (!pem) { console.error(`秘密鍵が見つかりません: ${pemFile}（tools/gen-keypair.js で生成）`); process.exit(1); }

let until = opt('--until');
if (!until) {
  const months = Number(opt('--months', '12'));
  const d = new Date(); d.setMonth(d.getMonth() + months); d.setDate(d.getDate() + 3); // 更新の余裕を3日
  until = d.toISOString().slice(0, 10);
}
const id = opt('--id') || crypto.randomBytes(4).toString('hex');
const payload = { v: 1, p: 'pro', e: until, id };
const body = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = crypto.sign(null, body, crypto.createPrivateKey(pem));
const key = `ZP1-${body.toString('base64url')}.${sig.toString('base64url')}`;

const ledger = path.join(__dirname, 'issued-keys.csv');
const memo = opt('--memo', '');
fs.appendFileSync(ledger, `${new Date().toISOString()},${id},${until},${JSON.stringify(memo)}\n`);

console.log(`有効期限: ${until}  発行ID: ${id}`);
console.log(key);
