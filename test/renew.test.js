// node test/renew.test.js — サーバー（functions/sign.js）のキーをブラウザ（src/license.js）が読めるか、と自動更新の判定
// 秘密鍵は使わない（使い捨ての鍵で署名し、license.js の公開鍵をテストのときだけ差し替える）。
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const sign = require(path.join(__dirname, '..', 'functions', 'sign.js'));
const Prod = require(path.join(__dirname, '..', 'src', 'license.js'));

// ---- ブラウザの代わり ----
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.window = { ZENGIN_CONFIG: { LICENSE_API: 'https://asia-northeast1-misefits.cloudfunctions.net/zenginponLicense' } };
let reply = null; // (url) => { status, body } | 'offline'
const sent = [];
globalThis.fetch = async (url) => {
  sent.push(url);
  const r = reply(url);
  if (r === 'offline') throw new TypeError('Failed to fetch');
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
};

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const RAW = publicKey.export({ format: 'jwk' }).x; // 生32バイト（base64url）。license.js の PUBLIC_KEY と同じ形
const L = Prod._withPublicKey(RAW);

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const today = day(0);
const ID = sign.licenseIdFor('sub_1TestRenew');

(async () => {
  let passed = 0;
  const t = async (name, fn) => {
    ls.clear(); sent.length = 0; reply = null;
    await fn();
    passed++;
    console.log('ok -', name);
  };

  await t('サーバーの functions/sign.js のキーを、ブラウザの verify が通す（形式・中身・署名の契約）', async () => {
    const key = sign.signKey(PEM, day(30), ID);
    const r = await L.verify(key);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.payload.id, ID);
    assert.equal(r.expiry, day(30));
    assert.equal(r.payload.p, 'pro');
  });

  await t('本番の公開鍵は、使い捨ての鍵の署名を通さない（差し替えはテストの中だけ）', async () => {
    assert.match(Prod.PUBLIC_KEY, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(Prod.PUBLIC_KEY, RAW);
    const r = await Prod.verify(sign.signKey(PEM, day(30), ID));
    assert.equal(r.ok, false);
  });

  await t('期限が遠く、確認したばかりなら問い合わせない', async () => {
    await L.activate(sign.signKey(PEM, day(25), ID));
    localStorage.setItem('zenginpon.licenseChecked', today);
    reply = () => { throw new Error('呼ばれないはず'); };
    const r = await L.refreshIfNeeded(false);
    assert.equal(r.reason, 'not-due');
    assert.equal(sent.length, 0);
  });

  await t('期限10日前なら取り直し、ライセンスIDだけを送って新しいキーに差し替える', async () => {
    await L.activate(sign.signKey(PEM, day(8), ID));
    localStorage.setItem('zenginpon.licenseChecked', today);
    reply = () => ({ status: 200, body: { key: sign.signKey(PEM, day(30), ID), expiry: day(30), status: 'active' } });
    const r = await L.refreshIfNeeded(false);
    assert.equal(r.refreshed, true);
    assert.equal(r.expiry, day(30));
    assert.equal(sent.length, 1);
    assert.equal(sent[0], `${window.ZENGIN_CONFIG.LICENSE_API}?id=${encodeURIComponent(ID)}`);
    assert.equal((await L.status()).expiry, day(30));
  });

  await t('前回の確認から7日たっていれば取り直す', async () => {
    await L.activate(sign.signKey(PEM, day(25), ID));
    localStorage.setItem('zenginpon.licenseChecked', day(-7));
    reply = () => ({ status: 200, body: { key: sign.signKey(PEM, day(30), ID) } });
    assert.equal((await L.refreshIfNeeded(false)).refreshed, true);
  });

  await t('410（Stripe で解約を確かめた）のときだけキーを消して Free に戻す', async () => {
    await L.activate(sign.signKey(PEM, day(5), ID));
    reply = () => ({ status: 410, body: { error: 'not entitled' } });
    const r = await L.refreshIfNeeded(true);
    assert.equal(r.revoked, true);
    assert.equal((await L.status()).key, '');
  });

  for (const [label, rep, reason] of [
    ['503（Stripe に照会できない）', { status: 503, body: { error: 'temporarily unavailable' } }, 'http-503'],
    ['500', { status: 500, body: { error: 'internal error' } }, 'http-500'],
    ['404（手動発行のキー）', { status: 404, body: { error: 'not found' } }, 'http-404'],
    ['オフライン', 'offline', 'offline'],
  ]) {
    await t(`${label} ではキーを消さない（手元のキーの期限まで使える）`, async () => {
      const key = sign.signKey(PEM, day(5), ID);
      await L.activate(key);
      reply = () => rep;
      const r = await L.refreshIfNeeded(true);
      assert.equal(r.refreshed, false);
      assert.equal(r.revoked, undefined);
      assert.equal(r.reason, reason);
      const st = await L.status();
      assert.equal(st.active, true);
      assert.equal(st.key, key);
      assert.equal(localStorage.getItem('zenginpon.licenseChecked'), null); // 次に開いたときにもう一度確かめる
    });
  }

  await t('期限切れのキーでも、同じライセンスIDで取り直して復帰できる', async () => {
    localStorage.setItem('zenginpon.license', sign.signKey(PEM, day(-2), ID));
    assert.equal((await L.status()).active, false);
    reply = () => ({ status: 200, body: { key: sign.signKey(PEM, day(30), ID) } });
    assert.equal((await L.refreshIfNeeded(false)).refreshed, true);
    assert.equal((await L.status()).active, true);
  });

  await t('別の契約（ライセンスIDが違う）のキーが返ってきても差し替えない', async () => {
    const key = sign.signKey(PEM, day(5), ID);
    await L.activate(key);
    reply = () => ({ status: 200, body: { key: sign.signKey(PEM, day(30), sign.licenseIdFor('sub_other')) } });
    const r = await L.refreshIfNeeded(true);
    assert.equal(r.reason, 'id-mismatch');
    assert.equal((await L.status()).key, key);
  });

  await t('署名の正しくないキーが返ってきても差し替えない', async () => {
    const key = sign.signKey(PEM, day(5), ID);
    await L.activate(key);
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    reply = () => ({ status: 200, body: { key: sign.signKey(other, day(30), ID) } });
    const r = await L.refreshIfNeeded(true);
    assert.equal(r.refreshed, false);
    assert.equal((await L.status()).key, key);
  });

  await t('更新先が受け付けない形のID（記号など）は送らない', async () => {
    await L.activate(sign.signKey(PEM, day(5), 'a/b..c'));
    reply = () => { throw new Error('呼ばれないはず'); };
    const r = await L.refreshIfNeeded(true);
    assert.equal(r.reason, 'no-id');
    assert.equal(sent.length, 0);
  });

  await t('手動発行のキー（tools/issue-key.js の16進8桁のID）は送れる形のまま（404 で何もしない）', async () => {
    await L.activate(sign.signKey(PEM, day(5), crypto.randomBytes(4).toString('hex')));
    reply = () => ({ status: 404, body: { error: 'not found' } });
    assert.equal((await L.refreshIfNeeded(true)).reason, 'http-404');
    assert.equal(sent.length, 1);
  });

  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
