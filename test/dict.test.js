// node test/dict.test.js — 銀行名・支店名・コードの照合を、実際の辞書（data/）と履歴で確かめる
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Z = require('../src/zengin.js');
const D = require('../src/dict.js');

const DATA = path.join(__dirname, '..', 'data');
D.setLoader(async (p) => {
  const f = path.join(DATA, p);
  if (!fs.existsSync(f)) throw new Error('not found ' + p);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
});

const one = (list) => { const e = list.filter((x) => x.exact || x.match === 'loose'); return e.length === 1 ? e[0].code : `(${list.map((x) => x.code + ':' + x.match).join(',')})`; };
const resolve = async (row) => { const r = { _info: [], _warn: [], ...row }; await D.resolveRows([r]); return r; };

(async () => {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };
  await D.load();

  // 口座・金額・名義はすべて架空。辞書だけは同梱の公開情報を使う。
  const transfer = (extra = {}) => ({ bankCode: '2356', branchCode: '001', depositType: '1',
    accountNo: '0123456', name: 'ﾃｽﾄ ｳｹﾄﾘﾆﾝ', amount: 12345, _info: [], _warn: [], ...extra });
  const mergerWarnings = (r) => r._warn.filter((w) => /興栄信用組合.*合併について公式案内/.test(w));
  const checkMerger = (r) => {
    assert.equal(mergerWarnings(r).length, 1, r._warn.join());
    assert.match(mergerWarnings(r)[0], /2026年11月24日/);
    assert.match(mergerWarnings(r)[0], /振込指定日/);
    assert.match(mergerWarnings(r)[0], /事前.*作成/);
    assert.match(mergerWarnings(r)[0], /受取人.*公式案内.*最新.*口座情報/);
    assert.doesNotMatch(mergerWarnings(r)[0], /合併予定|合併済み/);
  };

  await t('興栄: 明示コードは全5支店で注意し、口座・金額・出力バイトを変更しない', async () => {
    const list = JSON.parse(fs.readFileSync(path.join(DATA, 'branches', '2356.json'), 'utf8'));
    assert.equal(Object.keys(list).length, 5);
    for (const branchCode of Object.keys(list)) {
      const r = transfer({ branchCode }), before = { ...r };
      const h = { kind: '21', clientCode: '1234567890', clientName: 'ﾃｽﾄ', date: '1124',
        bankCode: '0005', branchCode: '001', depositType: '1', accountNo: '7654321' };
      const bytes = Z.encode(Z.build(h, [r]).text);
      await D.resolveRows([r]);
      checkMerger(r);
      for (const k of ['bankCode', 'branchCode', 'depositType', 'accountNo', 'name', 'amount']) assert.equal(r[k], before[k], k);
      assert.deepEqual(Z.encode(Z.build(h, [r]).text), bytes);
      assert.deepEqual(Z.validateRow(r, '21'), []); // 注意はエラーではなく、既存の出力可仕様を維持
    }
  });

  await t('興栄: 名前欄のコードと全角コードも補完後に注意する', async () => {
    for (const q of ['2356', '２３５６']) {
      const r = await resolve(transfer({ bankCode: '', branchCode: '', _rawBankName: q, _rawBranchName: '店番001' }));
      assert.equal(r.bankCode, '2356'); assert.equal(r.branchCode, '001'); checkMerger(r);
    }
  });

  await t('興栄: 正式名・辞書名・カナから銀行と支店を補完しても注意する', async () => {
    for (const q of ['興栄信用組合', ...D.bank('2356')]) {
      const r = await resolve(transfer({ bankCode: '', branchCode: '', _rawBankName: q, _rawBranchName: '本店' }));
      assert.equal(r.bankCode, '2356'); assert.equal(r.branchCode, '001'); checkMerger(r);
      assert.equal(r.accountNo, '0123456'); assert.equal(r.amount, 12345);
    }
  });

  await t('興栄: 不明・空欄の店番でも注意し、別の照合警告も保持する', async () => {
    for (const branchCode of ['', '999']) {
      const r = await resolve(transfer({ branchCode }));
      assert.equal(r.branchCode, branchCode); checkMerger(r);
      if (branchCode) assert.ok(r._warn.some((w) => /支店コード 999/.test(w)));
    }
    const r = await resolve(transfer({ _rawBankName: 'みずほ銀行', _warn: ['既存の確認事項'] }));
    checkMerger(r); assert.equal(r.bankCode, '2356');
    assert.ok(r._warn.includes('既存の確認事項'));
    assert.ok(r._warn.some((w) => /表の銀行名/.test(w)));
  });

  await t('興栄: 同じ行の再照合・警告配列の再作成で合併注意を重複させない', async () => {
    const r = transfer();
    for (let i = 0; i < 3; i++) { await D.resolveRows([r]); checkMerger(r); }
    r._warn = [];
    await D.resolveRows([r]); checkMerger(r);
  });

  await t('興栄: 合併予定日の前日・当日・翌日で注意を消さず、辞書から消えても置換しない', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'dict.js'), 'utf8');
    for (const day of ['2026-11-06', '2026-11-23', '2026-11-24', '2026-11-25']) {
      for (const removed of [false, true]) {
        const RealDate = Date;
        class Clock extends RealDate {
          constructor(...args) { super(...(args.length ? args : [day + 'T12:00:00Z'])); }
          static now() { return RealDate.parse(day + 'T12:00:00Z'); }
        }
        const sandbox = { module: { exports: {} }, Date: Clock };
        vm.runInNewContext(source, sandbox);
        const dict = sandbox.module.exports;
        dict.setLoader(async (p) => {
          const data = JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));
          if (removed && p === 'banks.json') delete data.banks['2356'];
          return data;
        });
        const r = transfer();
        await dict.resolveRows([r]); checkMerger(r);
        assert.equal(r.bankCode, '2356'); assert.equal(r.branchCode, '001');
        assert.equal(r.accountNo, '0123456'); assert.equal(r.amount, 12345);
      }
    }
  });

  await t('興栄以外: 混在行・隣のコード・既存の0120合併表の挙動を保持する', async () => {
    const rows = ['2356', '2351', '2355', '0001', '0120', '0121', '9999'].map((bankCode) => transfer({ bankCode, branchCode: '' }));
    await D.resolveRows(rows);
    checkMerger(rows[0]);
    for (const r of rows.slice(1)) assert.equal(mergerWarnings(r).length, 0);
    for (const r of rows.filter((r) => ['2351', '0001', '0120', '0121'].includes(r.bankCode))) assert.deepEqual(r._warn, []);
    assert.equal(D.mergedInfo('0120').new, '0121');
    assert.equal(D.mergedInfo('2356'), null);
    assert.match(rows.at(-1)._warn.join(), /一覧.*ありません/);
  });

  await t('銀行名: 正式名・略称・空白・半角カナ・ひらがな', async () => {
    for (const [q, want] of [['京都信用金庫', '1610'], ['京都信金', '1610'], ['京都 信用 金庫', '1610'], ['きょうとしんきん', '1610'], ['ｷｮｳﾄｼﾝｷﾝ', '1610'],
      ['京都中央信用金庫', '1611'], ['みずほ銀行', '0001'], ['ﾐｽﾞﾎ', '0001'], ['ゆうちょ銀行', '9900'], ['京都銀行', '0158']]) {
      assert.equal(one(D.findBank(q)), want, q);
    }
  });

  await t('銀行名: 英語・ローマ字・略称', async () => {
    for (const [q, want] of [['Mizuho Bank', '0001'], ['MUFG', '0005'], ['MUFG Bank, Ltd.', '0005'], ['SMBC', '0009'], ['Japan Post Bank', '9900'],
      ['Resona Bank', '0010'], ['PayPay Bank', '0033'], ['Rakuten Bank', '0036'], ['Kyoto Shinkin Bank', '1610'], ['kyoto chuo shinkin', '1611'], ['The Bank of Kyoto', '0158']]) {
      assert.equal(one(D.findBank(q)), want, q);
    }
  });

  await t('銀行名: 旧名・通称（改称の履歴を含む）', async () => {
    for (const [q, want] of [['三菱東京UFJ銀行', '0005'], ['住信SBIネット銀行', '0038'], ['ジャパンネット銀行', '0033'], ['郵便局', '9900'], ['札幌信用金庫', '1001'], ['SBI新生信託銀行', '0320'], ['ＳＢＩ新生信託', '0320'], ['SBI新生銀行', '0397']]) {
      assert.equal(one(D.findBank(q)), want, q);
    }
  });

  await t('銀行名の書き間違いは、確かな部分があれば推定（要確認）、無ければ候補だけ示す', async () => {
    const r = await resolve({ _rawBankName: '三井住友銀高' });          // 「三井住友」までは確か → 推定として補い要確認
    assert.equal(r.bankCode, '0009');
    assert.ok(r._warn.some((w) => /推定/.test(w)), r._warn.join());
    const r2 = await resolve({ _rawBankName: 'みずぽ銀行' });            // 1文字違い → 補わずに候補
    assert.equal(r2.bankCode, undefined);
    assert.ok(r2._warn.some((w) => /もしかして.*0001/.test(w)), r2._warn.join());
  });

  await D.branches('0144');
  await D.branchHistory('0144');

  await t('支店名: 金沢と金沢駅前を取り違えない（北陸銀行 0144）', async () => {
    assert.equal(one(D.findBranch('0144', '金沢')), '301');
    assert.equal(one(D.findBranch('0144', '金沢支店')), '301');
    assert.equal(one(D.findBranch('0144', '金沢駅前')), '305');
    assert.equal(one(D.findBranch('0144', '金沢駅前支店')), '305');
    assert.equal(one(D.findBranch('0144', 'かなざわえきまえ')), '305');
    assert.equal(one(D.findBranch('0144', 'Kanazawa Ekimae')), '305');
    assert.equal(one(D.findBranch('0144', 'KANAZAWA EKIMAE BRANCH')), '305');
    assert.equal(one(D.findBranch('0144', 'ｶﾅｻﾞﾜｴｷﾏｴ')), '305');
    const r = await resolve({ bankCode: '0144', _rawBranchName: '金沢' });
    assert.equal(r.branchCode, '301');
    assert.ok(r._info.some((x) => /似た名前の支店.*305 金沢駅前/.test(x)), r._info.join());
  });

  await t('支店コードと支店名が食い違っていたら知らせる（金沢 301 に「金沢駅前」）', async () => {
    const r = await resolve({ bankCode: '0144', branchCode: '301', _rawBranchName: '金沢駅前支店' });
    assert.equal(r.branchCode, '301');                 // 勝手に書き換えない
    assert.ok(r._warn.some((w) => /301 は「金沢」.*305 金沢駅前/.test(w)), r._warn.join());
    const ok = await resolve({ bankCode: '0144', branchCode: '305', _rawBranchName: '金沢駅前' });
    assert.equal(ok._warn.length, 0, ok._warn.join());
  });

  await t('銀行コードと銀行名が食い違っていたら知らせる', async () => {
    const r = await resolve({ bankCode: '1611', _rawBankName: '京都信用金庫' });
    assert.ok(r._warn.some((w) => /1611 は「京都中央信金」.*1610/.test(w)), r._warn.join());
  });

  await t('部分一致は推定として補い、要確認にする', async () => {
    const r = await resolve({ bankCode: '0144', _rawBranchName: '金沢駅' });
    assert.equal(r.branchCode, '305');
    assert.ok(r._warn.some((w) => /推定/.test(w)));
  });

  await t('支店名の書き間違いは候補を出す', async () => {
    const r = await resolve({ bankCode: '0144', _rawBranchName: '金沢駅全' });
    assert.equal(r.branchCode, undefined);
    assert.ok(r._warn.some((w) => /もしかして.*305/.test(w)), r._warn.join());
  });

  await t('名前が変わった支店の旧名から補う（北陸銀行 本店 → 本店営業部）', async () => {
    const r = await resolve({ bankCode: '0144', _rawBranchName: '本店' });
    assert.equal(r.branchCode, '101');
    assert.ok(r._warn.some((w) => /名前が変わって/.test(w)), r._warn.join());
  });

  await t('支店一覧から外れたコードは、時期と旧名を示す', async () => {
    const r = await resolve({ bankCode: '0144', branchCode: '533' });
    assert.ok(r._warn.some((w) => /533（札幌管理室出張所）は 2016年9月に支店一覧から外れて/.test(w)), r._warn.join());
  });

  await t('番号が振り直された支店は新しいコードに置き換えて知らせる', async () => {
    // 履歴の中から実例を1つ探して使う
    const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'history', 'banks.json'), 'utf8'));
    let found = null;
    for (const bankCode of idx.branchFiles) {
      const h = JSON.parse(fs.readFileSync(path.join(DATA, 'history', bankCode + '.json'), 'utf8'));
      for (const [code, evs] of Object.entries(h)) {
        const m = evs[evs.length - 1];
        if (m.t === 'moved') { found = { bankCode, code, to: m.to }; break; }
      }
      if (found) {
        await D.branches(found.bankCode);
        if (D.branch(found.bankCode, found.to) && !D.branch(found.bankCode, found.code)) break;
        found = null;
      }
    }
    assert.ok(found, 'moved の例が履歴に無い');
    const r = await resolve({ bankCode: found.bankCode, branchCode: found.code });
    assert.equal(r.branchCode, found.to);
    assert.ok(r._warn.some((w) => /番号が変わって/.test(w)), r._warn.join());
  });

  await t('名前欄にコードだけが書かれている', async () => {
    const r = await resolve({ _rawBankName: '0144', _rawBranchName: '店番305' });
    assert.equal(r.bankCode, '0144'); assert.equal(r.branchCode, '305');
  });

  await t('ローマ字の変換', async () => {
    assert.equal(D.romajiToKana('kanazawa ekimae'), 'カナザワエキマエ');
    assert.equal(D.romajiToKana('shimbashi'), 'シンバシ');
    assert.equal(D.romajiToKana('nippori'), 'ニッポリ');
    assert.equal(D.romajiToKana('kyoto'), 'キョト');
  });

  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
