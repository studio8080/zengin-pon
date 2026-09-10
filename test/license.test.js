// node test/license.test.js — 発行スクリプトと検証ライブラリの往復テスト
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const L = require('../src/license.js');

(async () => {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };

  const issue = (extra) => execFileSync('node', [path.join(__dirname, '..', 'tools', 'issue-key.js'), ...extra, '--memo', 'test'], { encoding: 'utf8' }).trim().split('\n').pop();

  await t('発行したキーが検証を通る', async () => {
    const key = issue(['--months', '1']);
    assert.match(key, /^ZP1-/);
    const r = await L.verify(key);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.payload.p, 'pro');
  });

  await t('期限切れは弾く', async () => {
    const key = issue(['--until', '2020-01-01']);
    const r = await L.verify(key);
    assert.equal(r.ok, false);
    assert.equal(r.expired, true);
  });

  await t('改ざんは弾く', async () => {
    const key = issue(['--months', '12']);
    const [head, sig] = key.split('.');
    const forged = head.slice(0, -2) + 'AA.' + sig; // payload を1文字変える
    const r = await L.verify(forged);
    assert.equal(r.ok, false);
    const r2 = await L.verify('ZP1-abc.def');
    assert.equal(r2.ok, false);
    const r3 = await L.verify('hello');
    assert.equal(r3.ok, false);
  });

  await t('空白や改行が混ざっていても通る', async () => {
    const key = issue(['--months', '1']);
    const r = await L.verify('  ' + key.slice(0, 20) + '\n' + key.slice(20) + ' ');
    assert.equal(r.ok, true);
  });

  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
