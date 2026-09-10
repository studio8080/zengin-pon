#!/usr/bin/env node
/*
 * Pro ライセンスキーの発行（手動運用でも Stripe Webhook からでも使える）
 *
 *   node tools/issue-key.js --months 12            年払い（今日から12か月）
 *   node tools/issue-key.js --months 1             月払い（今日から1か月）
 *   node tools/issue-key.js --until 2027-03-31     期限を直接指定
 *   node tools/issue-key.js --months 12 --id ord_123   発行IDを指定（Stripe の注文IDなど。既定はランダム）
 *   node tools/issue-key.js --months 12 --mail         そのまま送れるメール文面を出力
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

if (args.includes('--mail')) {
  const cycle = opt('--months') === '1' ? '月払い' : '年払い';
  console.log(`件名: 【全銀ポン】Proプランのライセンスキーをお送りします

このたびは全銀ポン Proプラン（${cycle}）をお申し込みいただき、ありがとうございます。
ライセンスキーをお送りします。

────────────────────────────
${key}
────────────────────────────

有効期限: ${until}

【使い方】
1. https://zenginpon.kokokikaku.com/ を開く
2. 「いますぐ変換」の右にある「⭐ Pro」ボタンを押す
3. 上のキーを貼り付けて「有効にする」を押す

これで件数無制限になり、列の割り当ての保存・振込元プロファイル・変換履歴・
バックアップが使えるようになります。会社のPCと自宅のPCなど、2台までご利用いただけます。
キーはブラウザの中で検証しますので、入力しても通信は発生しません。

【更新について】
有効期限が近づきましたら、こちらから新しいキーをお送りします。
ブラウザの設定を消した場合も、このメールのキーを入れ直せば復帰できます。
このメールは大切に保管してください。

ご不明な点、取込エラーなどありましたら、このメールにご返信ください。
※ 振込先の一覧やファイルそのものはお送りにならないでください。

--
全銀ポン（ここ企画）
https://zenginpon.kokokikaku.com/
studio@kokokikaku.com
（発行ID: ${id}）`);
} else {
  console.log(`有効期限: ${until}  発行ID: ${id}`);
  console.log(key);
}
