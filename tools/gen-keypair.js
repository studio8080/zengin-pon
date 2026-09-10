#!/usr/bin/env node
/*
 * ライセンス署名用の Ed25519 鍵ペアを1回だけ生成する。
 *
 *   node tools/gen-keypair.js <秘密鍵の保存先パス>
 *
 * - 秘密鍵はリポジトリの外に保存する（例: C:\Users\<you>\.zengin-pon\license-private.pem）。
 *   決して commit しない。失くすと以後キーを発行できないので、パスワードマネージャーにも控える。
 * - 公開鍵（base64url, 32バイト）を標準出力に出すので、src/license.js の PUBLIC_KEY に貼る。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
if (!out) { console.error('usage: node tools/gen-keypair.js <private-key-path>'); process.exit(1); }
if (fs.existsSync(out)) { console.error(`already exists: ${out}（上書きしません）`); process.exit(1); }

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32); // SPKI の末尾32バイトが生の公開鍵
console.log('private key saved:', out);
console.log('PUBLIC_KEY (paste into src/license.js):', raw.toString('base64url'));
