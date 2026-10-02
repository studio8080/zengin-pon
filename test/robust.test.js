// node test/robust.test.js — 表の書き方の揺れ・特殊な文字・書き間違いに強いかを確かめる
'use strict';
const assert = require('node:assert/strict');
const Z = require('../src/zengin.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const row = (raw) => Z.normalizeRow({ bankCode: '0005', branchCode: '001', depositType: '普通', accountNo: '1234567', name: 'ﾔﾏﾀﾞ ﾀﾛｳ', amount: 1000, ...raw });

t('全角数字の口座番号・コード', () => {
  const r = row({ bankCode: '０００５', branchCode: '００１', accountNo: '１２３４５６７' });
  assert.equal(r.bankCode, '0005'); assert.equal(r.branchCode, '001'); assert.equal(r.accountNo, '1234567');
});

t('Excel の数値表記（.0 付き・指数表記・数値型）', () => {
  assert.equal(row({ accountNo: '1234567.0' }).accountNo, '1234567');
  assert.equal(row({ accountNo: '1.234567E+06' }).accountNo, '1234567');
  assert.equal(row({ accountNo: 123456 }).accountNo, '123456');           // 先頭0が落ちた → 出力時に0埋め
  assert.equal(row({ bankCode: 5, branchCode: 1 }).bankCode, '0005');
  assert.equal(row({ bankCode: '5.0', branchCode: '1.0' }).branchCode, '001');
  assert.deepEqual(Z.validateRow(row({ accountNo: 123456 }), '21'), []);
});

t('口座番号の区切り・前後の空白', () => {
  assert.equal(row({ accountNo: ' 123-4567 ' }).accountNo, '1234567');
  assert.equal(row({ accountNo: '1234 567' }).accountNo, '1234567');
});

t('金額の書き方の揺れ', () => {
  for (const v of ['1,000', '1,000円', '¥1,000', '￥1,000', '\\1,000', '１，０００', ' 1000 ', '1000.0', '1,000円也']) {
    assert.equal(Z.parseAmount(v), 1000, v);
  }
  assert.equal(Z.parseAmount(1000.4), 1000);
});

t('マイナス・△付きの金額はエラーにする（黙って正にしない）', () => {
  for (const v of ['-1000', '－1,000', '△1,000', '▲1000', '(1,000)']) {
    const r = row({ amount: v });
    assert.ok(Z.validateRow(r, '21').some((e) => /金額/.test(e)), v);
  }
});

t('預金種目の書き方の揺れ', () => {
  for (const [v, want] of [['普通', '1'], ['普通預金', '1'], ['普', '1'], ['1', '1'], ['１', '1'], ['ﾌﾂｳ', '1'], ['総合', '1'], ['総合口座', '1'],
    ['当座', '2'], ['当座預金', '2'], ['2', '2'], ['貯蓄', '4'], ['その他', '9'], ['', '1']]) {
    assert.equal(Z.parseDepositType(v), want, v);
  }
});

t('読めない預金種目は「その他」にせずエラーにする', () => {
  const r = row({ depositType: '定期' });
  assert.ok(Z.validateRow(r, '21').some((e) => /預金種目/.test(e)));
});

t('名義の敬称（様・殿・御中）を外す', () => {
  assert.equal(row({ name: 'ヤマダ タロウ 様' }).name, 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(row({ name: 'ヤマダタロウ様' }).name, 'ﾔﾏﾀﾞﾀﾛｳ');
  assert.equal(row({ name: 'ココキカク株式会社　御中' }).name, 'ｺｺｷｶｸ(ｶ');
  assert.equal(row({ name: 'サマタ ヒロシ' }).name, 'ｻﾏﾀ ﾋﾛｼ'); // 「サマ」で始まる名前は消さない
});

t('法人の種類の省略形（(株)・㈱・(有)・カブシキガイシャ）', () => {
  assert.equal(Z.toZenginChars('(株)ココキカク'), 'ｶ)ｺｺｷｶｸ');
  assert.equal(Z.toZenginChars('（株）ココキカク'), 'ｶ)ｺｺｷｶｸ');
  assert.equal(Z.toZenginChars('㈱ココキカク'), 'ｶ)ｺｺｷｶｸ');
  assert.equal(Z.toZenginChars('ココキカク㈱'), 'ｺｺｷｶｸ(ｶ');
  assert.equal(Z.toZenginChars('(有)タクミ'), 'ﾕ)ﾀｸﾐ');
  assert.equal(Z.toZenginChars('㈲タクミ'), 'ﾕ)ﾀｸﾐ');
  assert.equal(Z.toZenginChars('カブシキガイシャ ココキカク'), 'ｶ)ｺｺｷｶｸ');
  assert.equal(Z.toZenginChars('ココキカク カブシキガイシャ'), 'ｺｺｷｶｸ(ｶ');
  assert.equal(Z.toZenginChars('ユウゲンガイシャ タクミ'), 'ﾕ)ﾀｸﾐ');
  assert.equal(Z.toZenginChars('ｶ)ｺｺｷｶｸ'), 'ｶ)ｺｺｷｶｸ');                 // すでに略語ならそのまま
});

t('名義の特殊な空白・記号', () => {
  assert.equal(Z.toZenginChars('ヤマダ　　タロウ'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(Z.toZenginChars('ヤマダ\tタロウ'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(Z.toZenginChars('ヤマダ タロウ'), 'ﾔﾏﾀﾞ ﾀﾛｳ');      // ノーブレークスペース（Web からのコピペ）
  assert.equal(Z.toZenginChars('ヤマダ​タロウ'), 'ﾔﾏﾀﾞﾀﾛｳ');       // ゼロ幅スペース
  assert.equal(Z.toZenginChars('ガッコウ'), 'ｶﾞﾂｺｳ');            // 結合文字の濁点
  assert.equal(Z.toZenginChars('ﾔﾏﾀﾞ ﾀﾛｳ'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.deepEqual(Z.invalidChars(Z.toZenginChars('エー＆ビー')), ['&']);  // 使えない文字は残してエラーで知らせる
});

t('30文字を超える名義は黙って切らずにエラーにする', () => {
  const r = row({ name: 'ア'.repeat(31) });
  assert.ok(Z.validateRow(r, '21').some((e) => /30文字/.test(e)));
});

console.log(`\n${passed} tests passed`);
