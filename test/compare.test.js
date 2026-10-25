const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/compare');
const row = (p = {}) => C.normalize({ id: '001', bankCode: '5', branchCode: '1', depositType: '1', accountNo: '1234567', name: 'ﾃｽﾄ', amount: '1,000', ...p });
test('stable identifier detects account, name and amount changes without mutating inputs', () => {
  const b = [row()], a = [row({ accountNo: '7654321', name: 'ﾍﾝｺｳ', amount: 1200 })], original = JSON.stringify([b, a]);
  const r = C.compare(b, a, true);
  assert.equal(r.matches[0].accountChanged, true); assert.equal(r.matches[0].nameChanged, true); assert.equal(r.matches[0].delta, 200); assert.equal(r.totalDelta, 200);
  assert.deepEqual([r.added.length, r.removed.length], [0, 0]); assert.equal(JSON.stringify([b, a]), original);
});
test('same name without identifier never becomes a confirmed person or assigned delta', () => {
  const r = C.compare([row()], [row({ accountNo: '7654321', amount: 1500 })], false);
  assert.equal(r.matches.length, 0); assert.equal(r.added.length, 1); assert.equal(r.removed.length, 1); assert.equal(r.ambiguous.length, 1); assert.equal(r.totalDelta, 500);
});
test('account fallback is explicit, detects amounts and retains name change', () => {
  const r = C.compare([row()], [row({ id: 'other', name: 'ﾍﾝｺｳ', amount: 0 })], false);
  assert.match(r.matches[0].basis, /同一人物とは未確認/); assert.equal(r.matches[0].delta, -1000); assert.equal(r.matches[0].nameChanged, true);
});
test('different stable identifiers never fallback to the same account', () => {
  const r = C.compare([row()], [row({ id: '002' })], true); assert.equal(r.matches.length, 0); assert.equal(r.added.length, 1);
});
test('duplicate IDs on either side and duplicate accounts stay unresolved', () => {
  for (const id of [true, false]) for (const reverse of [true, false]) {
    const [b, a] = reverse ? [[row(), row()], [row()]] : [[row()], [row(), row()]];
    const r = C.compare(b, a, id); assert.equal(r.matches.length, 0); assert.ok(r.ambiguous.length); assert.equal(r.beforeTotal, reverse ? 2000 : 1000);
  }
});
test('empty identifier stays unresolved and leading zero identifiers remain distinct', () => {
  const r = C.compare([row({ id: '' }), row()], [row({ id: '' }), row({ id: '1' })], true);
  assert.equal(r.matches.length, 0); assert.ok(r.ambiguous.some(x => /空/.test(x.reason)));
});
test('added and removed rows keep their own totals', () => {
  const r = C.compare([row()], [row({ id: '002', name: 'ﾍﾞﾂ', accountNo: '7654321', amount: 2000 })], true);
  assert.equal(r.removed.length, 1); assert.equal(r.added.length, 1); assert.equal(r.beforeTotal, 1000); assert.equal(r.afterTotal, 2000);
});
test('reject malformed amount, overlong code, nonnumeric account and missing type', () => {
  for (const p of [{ amount: '-1' }, { amount: '100abc' }, { amount: '1.5' }, { amount: '1,,2' }, { amount: '' }, { amount: '9007199254740992' }, { bankCode: '12345' }, { accountNo: 'abc' }, { depositType: '' }, { name: '' }]) assert.throws(() => row(p));
  assert.throws(() => C.compare([row({ amount: Number.MAX_SAFE_INTEGER }), row()], [], true));
});
test('large same-name fixture groups ambiguity without a Cartesian explosion', () => {
  const b = Array.from({ length: 10000 }, (_, i) => row({ id: 'a' + i })), a = b.map((r, i) => ({ ...r, id: 'b' + i, accountNo: '7654321' }));
  const r = C.compare(b, a, true); assert.equal(r.ambiguous.length, 1); assert.equal(r.ambiguous[0].before.length, 10000);
});
