// node test/organize.test.js
const assert = require('node:assert/strict');
const O = require('../src/organize.js');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok -', name); }

t('セル分解', () => {
  assert.deepEqual(O.splitCell('0005-001'), { bankCode: '0005', branchCode: '001' });
  assert.deepEqual(O.splitCell('０００５／００１'), { bankCode: '0005', branchCode: '001' });
  assert.deepEqual(O.splitCell('普通 1234567'), { depositType: '普通', accountNo: '1234567' });
  assert.deepEqual(O.splitCell('当座1234567'), { depositType: '当座', accountNo: '1234567' });
  assert.deepEqual(O.splitCell('三菱UFJ銀行 渋谷支店'), { bankName: '三菱UFJ銀行', branchName: '渋谷支店' });
  assert.deepEqual(O.splitCell('京都中央信用金庫本店営業部'), { bankName: '京都中央信用金庫', branchName: '本店営業部' });
  assert.deepEqual(O.splitCell('山田 太郎（ヤマダ タロウ）'), { name: '山田 太郎', kana: 'ヤマダ タロウ' });
  assert.equal(O.splitCell('1234567'), null);
  assert.equal(O.splitCell('山田太郎'), null);
});

t('列の値の形', () => {
  assert.equal(O.profileColumn(['0005', '0009', '0001', '0036']).type, 'code4');
  assert.equal(O.profileColumn(['001', '123', '45']).type, 'code3');
  assert.equal(O.profileColumn(['1234567', '7654321', '12345']).type, 'account');
  assert.equal(O.profileColumn(['285,600', '243,100', '¥98,000']).type, 'amount');
  assert.equal(O.profileColumn([285600, 243100, 98000].map(String)).type, 'amount');
  assert.equal(O.profileColumn(['ヤマダ タロウ', 'さとう はなこ', 'ｽｽﾞｷ ｲﾁﾛｳ']).type, 'kana');
  assert.equal(O.profileColumn(['山田 太郎', '佐藤 花子']).type, 'kanjiName');
  assert.equal(O.profileColumn(['三菱UFJ銀行', 'みずほ銀行', '京都信用金庫']).type, 'bankText');
  assert.equal(O.profileColumn(['渋谷支店', '本店営業部', '新宿支店']).type, 'branchText');
  assert.equal(O.profileColumn(['普通', '当座', '普通']).type, 'deposit');
});

t('見出しなし・並び順バラバラでも推定できる', () => {
  const table = [
    ['285,600', '山田 太郎', 'ヤマダ タロウ', '0005', '001', '普通', '1234567'],
    ['243,100', '佐藤 花子', 'サトウ ハナコ', '0009', '123', '当座', '7654321'],
    ['98,000', '鈴木 一郎', 'スズキ イチロウ', '0001', '045', '普通', '12345'],
  ];
  const a = O.analyze(table, '11');
  assert.equal(a.hasHeader, false);
  assert.equal(a.mapping.amount, 0);
  assert.equal(a.mapping.name, 2);
  assert.equal(a.mapping.bankCode, 3);
  assert.equal(a.mapping.branchCode, 4);
  assert.equal(a.mapping.depositType, 5);
  assert.equal(a.mapping.accountNo, 6);
  assert.equal(a.info.bankCode.method, 'inferred');
});

t('結合セル＋2段見出し＋合計行', () => {
  const table = [
    ['2026年9月分 支払一覧', '', '', ''],
    ['支払先', '振込先', '口座', '支払額'],
    ['株式会社山田商店（ヤマダショウテン）', '三菱UFJ銀行 本店', '普通 1234567', '330,000'],
    ['佐藤工務店（サトウコウムテン）', 'みずほ銀行 渋谷支店', '当座 7654321', '125,400'],
    ['合計', '', '', '455,400'],
  ];
  const a = O.analyze(table, '21');
  assert.equal(a.hasHeader, true);
  assert.equal(a.headerIdx, 1);
  const H = a.table[a.headerIdx];
  assert.ok(H.includes('振込先→銀行名'));
  assert.ok(H.includes('振込先→支店名'));
  assert.ok(H.includes('口座→預金種目'));
  assert.ok(H.includes('口座→口座番号'));
  assert.ok(H.includes('支払先→カナ'));
  assert.equal(H[a.mapping.bankName], '振込先→銀行名');
  assert.equal(H[a.mapping.branchName], '振込先→支店名');
  assert.equal(H[a.mapping.accountNo], '口座→口座番号');
  assert.equal(H[a.mapping.depositType], '口座→預金種目');
  assert.equal(H[a.mapping.name], '支払先→カナ');
  assert.equal(H[a.mapping.amount], '支払額');
  assert.equal(a.mapping.bankCode, undefined); // コード列は無い → 辞書で逆引きする
  assert.equal(O.isTotalRow(a.table[4], a.mapping), true);
  assert.equal(O.isTotalRow(a.table[2], a.mapping), false);
  assert.ok(a.notes.length >= 3);
});

t('見出し「銀行」に銀行名が入っている場合は銀行コードにしない', () => {
  const table = [
    ['氏名', '銀行', '支店', '口座番号', '金額'],
    ['ヤマダ タロウ', 'みずほ銀行', '渋谷支店', '1234567', '100000'],
    ['サトウ ハナコ', '楽天銀行', 'ダンス支店', '7654321', '200000'],
  ];
  const a = O.analyze(table, '21');
  assert.equal(a.mapping.bankCode, undefined);
  assert.equal(a.mapping.bankName, 1);
  assert.equal(a.mapping.branchName, 2);
  assert.equal(a.mapping.name, 0);
});

console.log(`\n${passed} tests passed`);
