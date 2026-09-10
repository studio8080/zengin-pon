/*
 * sign.js — ライセンスキーの署名（Cloud Functions 側）
 * tools/issue-key.js と同じ形式のキーを作る。src/license.js が公開鍵で検証する。
 *
 *   ZP1-<base64url(payload JSON)>.<base64url(Ed25519 署名)>
 *   payload = { v:1, p:"pro", e:"YYYY-MM-DD", id:"ライセンスID" }
 */
const crypto = require('crypto');

/** サブスクリプションIDから安定したライセンスID（更新しても変わらない）を作る */
function licenseIdFor(subscriptionId) {
  return crypto.createHash('sha256').update(String(subscriptionId)).digest('base64url').slice(0, 12);
}

/**
 * @param {string} pem   Ed25519 秘密鍵（PKCS#8 PEM）
 * @param {string} expiry 'YYYY-MM-DD'
 * @param {string} id    ライセンスID
 */
function signKey(pem, expiry, id) {
  const payload = { v: 1, p: 'pro', e: expiry, id };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, body, crypto.createPrivateKey(pem));
  return `ZP1-${body.toString('base64url')}.${sig.toString('base64url')}`;
}

/** Unix秒 → 'YYYY-MM-DD'（猶予日数を足す） */
function expiryFromUnix(unixSeconds, graceDays) {
  const d = new Date(Number(unixSeconds) * 1000);
  d.setDate(d.getDate() + (graceDays || 0));
  return d.toISOString().slice(0, 10);
}

module.exports = { licenseIdFor, signKey, expiryFromUnix };
