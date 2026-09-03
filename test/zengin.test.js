// node test/zengin.test.js
const assert = require('node:assert/strict');
const Z = require('../src/zengin.js');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok -', name); }

t('全角カナ→半角カナ（濁点分離）', () => {
  assert.equal(Z.toZenginChars('ヤマダ　タロウ'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(Z.toZenginChars('やまだ たろう'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(Z.toZenginChars('パピプペポ'), 'ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ');
  assert.equal(Z.toZenginChars('ヴィクター'), 'ｳﾞｲｸﾀｰ');
});

t('小書きカナ→大文字、英字→大文字、全角英数→半角', () => {
  assert.equal(Z.toZenginChars('キャノン'), 'ｷﾔﾉﾝ');
  assert.equal(Z.toZenginChars('キャノン', { smallToLarge: false }), 'ｷｬﾉﾝ');
  assert.equal(Z.toZenginChars('ａｂｃ１２３'), 'ABC123');
  assert.equal(Z.toZenginChars('abc'), 'ABC');
});

t('法人略語', () => {
  assert.equal(Z.toZenginChars('株式会社ココキカク'), 'ｶ)ｺｺｷｶｸ');
  assert.equal(Z.toZenginChars('ココキカク株式会社'), 'ｺｺｷｶｸ(ｶ');
  assert.equal(Z.toZenginChars('ココ株式会社キカク'), 'ｺｺ(ｶ)ｷｶｸ');
  assert.equal(Z.toZenginChars('有限会社タクミ'), 'ﾕ)ﾀｸﾐ');
  assert.equal(Z.toZenginChars('一般社団法人ニホン'), 'ｼﾔ)ﾆﾎﾝ');
  assert.equal(Z.toZenginChars('特定非営利活動法人ミライ'), 'ﾄｸﾋ)ﾐﾗｲ');
  assert.equal(Z.toZenginChars('ココキカク株式会社 オオサカ営業所'), 'ｺｺｷｶｸ(ｶ) ｵｵｻｶ(ｴｲ');
});

t('記号', () => {
  assert.equal(Z.toZenginChars('エー・ビー'), 'ｴｰ.ﾋﾞｰ');
  assert.equal(Z.toZenginChars('ＡＢＣ－１'), 'ABC-1');
  assert.equal(Z.toZenginChars('（ヤマダ）'), '(ﾔﾏﾀﾞ)');
});

t('使えない文字の検出', () => {
  assert.deepEqual(Z.invalidChars(Z.toZenginChars('山田太郎')), ['山', '田', '太', '郎']);
  assert.deepEqual(Z.invalidChars('ﾔﾏﾀﾞ ﾀﾛｳ'), []);
});

t('金額・預金種目の解釈', () => {
  assert.equal(Z.parseAmount('¥1,234,567'), 1234567);
  assert.equal(Z.parseAmount('１２３'), 123);
  assert.equal(Z.parseAmount(1000.0), 1000);
  assert.equal(Z.parseDepositType('普通'), '1');
  assert.equal(Z.parseDepositType('当座'), '2');
  assert.equal(Z.parseDepositType('2'), '2');
  assert.equal(Z.parseDepositType(''), '1');
});

t('ゆうちょ 記号番号→店番・口座番号', () => {
  assert.deepEqual(Z.yuchoToZengin('12340', '12345671'), { bankCode: '9900', branchCode: '238', depositType: '1', accountNo: '1234567' });
  assert.deepEqual(Z.yuchoToZengin('00120', '123456'), { bankCode: '9900', branchCode: '019', depositType: '2', accountNo: '0123456' });
});

const header = {
  kind: '21', clientCode: '1234567890', clientName: Z.toZenginChars('株式会社ココキカク'), date: '0925',
  bankCode: '0005', bankName: '', branchCode: '001', branchName: '', depositType: '1', accountNo: '1234567',
};
const rows = [
  Z.normalizeRow({ bankCode: '0009', branchCode: '123', depositType: '普通', accountNo: '7654321', name: 'ヤマダ　タロウ', amount: '250,000' }),
  Z.normalizeRow({ bankCode: '1', branchCode: '1', depositType: '当座', accountNo: '1', name: 'サトウ　ハナコ', amount: 1000, customerCode1: '42' }),
];

t('レコード長が全て120', () => {
  const out = Z.build(header, rows, { newline: 'CRLF' });
  assert.equal(out.records.length, 5);
  for (const r of out.records) assert.equal(r.length, 120);
  assert.equal(out.count, 2);
  assert.equal(out.total, 251000);
  assert.equal(out.text.length, 5 * 122);
});

t('ヘッダー・データ・トレーラの内容', () => {
  const out = Z.build(header, rows);
  const h = out.records[0];
  assert.equal(h.slice(0, 1), '1');
  assert.equal(h.slice(1, 3), '21');
  assert.equal(h.slice(3, 4), '0');
  assert.equal(h.slice(4, 14), '1234567890');
  assert.equal(h.slice(14, 54).trim(), 'ｶ)ｺｺｷｶｸ');
  assert.equal(h.slice(54, 58), '0925');
  assert.equal(h.slice(58, 62), '0005');
  assert.equal(h.slice(77, 80), '001');
  assert.equal(h.slice(95, 96), '1');
  assert.equal(h.slice(96, 103), '1234567');
  const d = out.records[1];
  assert.equal(d.slice(0, 1), '2');
  assert.equal(d.slice(1, 5), '0009');
  assert.equal(d.slice(20, 23), '123');
  assert.equal(d.slice(42, 43), '1');
  assert.equal(d.slice(43, 50), '7654321');
  assert.equal(d.slice(50, 80).trim(), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(d.slice(80, 90), '0000250000');
  assert.equal(d.slice(90, 91), '0');
  assert.equal(d.slice(111, 112), '7'); // 振込指定区分 電信
  const d2 = out.records[2];
  assert.equal(d2.slice(1, 5), '0001');
  assert.equal(d2.slice(20, 23), '001');
  assert.equal(d2.slice(42, 43), '2');
  assert.equal(d2.slice(43, 50), '0000001');
  assert.equal(d2.slice(91, 101), '0000000042');
  const tr = out.records[3];
  assert.equal(tr.slice(0, 1), '8');
  assert.equal(tr.slice(1, 7), '000002');
  assert.equal(tr.slice(7, 19), '000000251000');
  assert.equal(out.records[4].slice(0, 1), '9');
});

t('給与振込のデータレコード', () => {
  const h2 = Object.assign({}, header, { kind: '11' });
  const r = Z.normalizeRow({ bankCode: '0005', branchCode: '010', accountNo: '1111111', name: 'すずき いちろう', amount: 300000, employeeNo: 'E-007', deptCode: '12' });
  const out = Z.build(h2, [r]);
  const d = out.records[1];
  assert.equal(d.length, 120);
  assert.equal(d.slice(91, 101), '0000000007');
  assert.equal(d.slice(101, 111), '0000000012');
  assert.equal(d.slice(111, 120), '         ');
  assert.equal(out.records[0].slice(1, 3), '11');
});

t('JIS X 0201 エンコードと逆変換', () => {
  const s = 'ﾔﾏﾀﾞ ﾀﾛｳ ABC-1 ¥';
  const bytes = Z.encode(s);
  assert.equal(bytes.length, s.length);
  assert.equal(bytes[0], 0xD4); // ﾔ
  assert.equal(bytes[3], 0xDE); // ﾞ
  assert.equal(bytes[bytes.length - 1], 0x5C); // ¥
  assert.equal(Z.decode(bytes), s);
  assert.throws(() => Z.encode('山'));
});

t('検証エラー', () => {
  const bad = Z.normalizeRow({ bankCode: '12', branchCode: '', accountNo: '', name: '山田', amount: '0' });
  const errs = Z.validateRow(bad, '21');
  assert.ok(errs.some((e) => e.includes('支店コード')));
  assert.ok(errs.some((e) => e.includes('口座番号')));
  assert.ok(errs.some((e) => e.includes('使えない文字')));
  assert.ok(errs.some((e) => e.includes('金額')));
  assert.deepEqual(Z.validateRow(rows[0], '21'), []);
  assert.deepEqual(Z.validateHeader(header), []);
});

console.log(`\n${passed} tests passed`);
