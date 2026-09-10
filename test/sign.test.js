// node test/sign.test.js — Cloud Functions 側の期限計算
const assert = require('node:assert/strict');
const { licenseIdFor, expiryFromUnix, daysFromToday, cappedExpiry } = require('../functions/sign.js');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok -', name); }

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

t('ライセンスIDはサブスクIDから決まり、更新しても変わらない', () => {
  assert.equal(licenseIdFor('sub_abc'), licenseIdFor('sub_abc'));
  assert.notEqual(licenseIdFor('sub_abc'), licenseIdFor('sub_def'));
  assert.match(licenseIdFor('sub_abc'), /^[A-Za-z0-9_-]{12}$/);
});

t('月払い: 期間末+猶予が30日以内ならその日が期限', () => {
  // 今から20日後が期間末 → 20+3=23日後（30日上限より手前）
  const e = cappedExpiry(nowSec() + 20 * DAY, 3, 30);
  assert.equal(e, daysFromToday(23));
});

t('年払い: 期間末が遠くても30日で頭打ち', () => {
  const e = cappedExpiry(nowSec() + 365 * DAY, 3, 30);
  assert.equal(e, daysFromToday(30));
});

t('解約済み: 期間末が近ければ延長されない', () => {
  // 3日後に期間末 → 3+3=6日後。30日上限は効かない
  const e = cappedExpiry(nowSec() + 3 * DAY, 3, 30);
  assert.equal(e, daysFromToday(6));
});

t('即時解約: 期間末が過去なら過去の日付になる（＝失効）', () => {
  const e = cappedExpiry(nowSec() - 10 * DAY, 3, 30);
  assert.equal(e, daysFromToday(-7));
  assert.ok(e < new Date().toISOString().slice(0, 10));
});

t('expiryFromUnix と daysFromToday', () => {
  assert.equal(expiryFromUnix(nowSec(), 0), daysFromToday(0));
  assert.equal(expiryFromUnix(nowSec() + DAY, 1), daysFromToday(2));
});

console.log(`\n${passed} tests passed`);
