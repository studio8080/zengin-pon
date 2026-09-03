/*
 * organize.js — 取り込んだ表の「自動整理」
 *
 * 前提: 利用者のExcelは全銀の項目順に並んでいない。見出しが無い・変則的・2段になっている、
 * 「銀行名 支店名」「普通 1234567」「0005-001」のように1セルに複数項目が入っている、
 * 合計行が混ざっている、などが普通に起きる。
 *
 * やること（AIは使わない。全部ルール）
 *   1. 見出し行の推定（見出しの語＋その下の値の形の両方で採点）
 *   2. 結合セルの分解（仮想列として右に追加する）
 *   3. 各列の「値の形」を判定（4桁コード／3桁コード／口座番号／金額／カナ／漢字名／銀行支店の文字列／預金種目）
 *   4. 見出し名 → 値の形 の順で全銀項目に割り当て。推定根拠と確信度を返す
 *   5. 合計・小計行の除外
 *
 * 依存なし。ブラウザ（window.Organize）でも Node でも動く。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Organize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 全銀項目と見出しのエイリアス ---------------------------------------
  const FIELDS = [
    { key: 'bankCode', label: '銀行コード', required: true, aliases: ['銀行コード', '金融機関コード', '銀行番号', '銀行cd', '金融機関cd', '金融機関番号', 'bankcode', 'bank_code', 'bankno', '銀行'] },
    { key: 'branchCode', label: '支店コード', required: true, aliases: ['支店コード', '店番', '支店番号', '店番号', '支店cd', '店舗コード', 'branchcode', 'branch_code', 'branchno', '支店'] },
    { key: 'accountNo', label: '口座番号', required: true, aliases: ['口座番号', '口座no', '口座', 'account', 'accountno', 'acct'] },
    { key: 'name', label: '受取人名（カナ）', required: true, aliases: ['受取人名カナ', '受取人カナ', '口座名義カナ', '名義カナ', '氏名カナ', '振込先名カナ', 'フリガナ', 'ふりがな', 'カナ', '受取人名', '受取人', '振込先名', '口座名義', '名義人', '名義', '振込先', '氏名', '名前', '社員名', '従業員名', '取引先名', '支払先', 'name', 'recipient'] },
    { key: 'amount', label: '振込金額', required: true, aliases: ['振込金額', '差引支給額', '振込額', '支給額', '手取額', '手取り', '支払金額', '支払額', '請求金額', '金額', 'amount', 'salary'] },
    { key: 'depositType', label: '預金種目', aliases: ['預金種目', '預金種別', '口座種別', '口座種目', '科目', '種目', '種別', 'account_type'] },
    { key: 'bankName', label: '銀行名', aliases: ['銀行名', '金融機関名', 'bankname'] },
    { key: 'branchName', label: '支店名', aliases: ['支店名', 'branchname'] },
    { key: 'customerCode1', label: '顧客コード1', kinds: ['21'], aliases: ['顧客コード1', '顧客コード', '取引先コード', '得意先コード', '仕入先コード', '顧客cd'] },
    { key: 'customerCode2', label: '顧客コード2', kinds: ['21'], aliases: ['顧客コード2'] },
    { key: 'transferType', label: '振込指定区分（7/8）', kinds: ['21'], aliases: ['振込指定区分', '電信文書'] },
    { key: 'ediFlag', label: 'EDI識別（Y）', kinds: ['21'], aliases: ['edi', '識別表示'] },
    { key: 'employeeNo', label: '社員番号', kinds: ['11', '12'], aliases: ['社員番号', '従業員番号', '社員no', '社員cd', '従業員コード', '社員コード', '従業員no'] },
    { key: 'deptCode', label: '所属コード', kinds: ['11', '12'], aliases: ['所属コード', '部門コード', '部署コード', '所属'] },
    { key: 'newCode', label: '新規コード', aliases: ['新規コード', '新規'] },
    { key: 'yuchoKigo', label: 'ゆうちょ記号', aliases: ['ゆうちょ記号', '記号'] },
    { key: 'yuchoBango', label: 'ゆうちょ番号', aliases: ['ゆうちょ番号', '番号'] },
  ];

  // ---- 文字ユーティリティ ---------------------------------------------------
  function toHalf(s) { return String(s == null ? '' : s).replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }
  function normHeader(h) { return toHalf(h).toLowerCase().replace(/[\s　]/g, '').replace(/[（）()\[\]【】]/g, ''); }
  function digitsOnly(s) { return toHalf(s).replace(/[^0-9]/g, ''); }
  const KANA_RE = /[ぁ-ゖァ-ヺーｦ-ﾟ]/;
  const KANJI_RE = /[一-鿿]/;
  const BANK_WORD_RE = /(銀行|信用金庫|信金|信用組合|信組|労働金庫|労金|農協|JA|ＪＡ|ゆうちょ|ネット銀行)/;
  const BRANCH_WORD_RE = /(支店|本店|営業部|出張所|支所)/;
  const DEPOSIT_RE = /^(普通|当座|貯蓄|普|当|ﾌﾂｳ|ﾄｳｻﾞ|フツウ|トウザ|[1249])$/;
  const TOTAL_RE = /^(合計|小計|総合計|総計|計|合計金額|total|sum)$/i;

  function kanaRatio(s) {
    const t = String(s).replace(/[\s　]/g, '');
    if (!t) return 0;
    let k = 0; for (const ch of t) if (KANA_RE.test(ch)) k++;
    return k / [...t].length;
  }
  function isAmountLike(s) {
    const t = toHalf(s).replace(/[,，¥￥\s円]/g, '');
    return /^-?\d+(\.\d+)?$/.test(t) && t.replace('-', '').replace(/^0+/, '').length >= 1;
  }

  // ---- 1セルの分解 ---------------------------------------------------------
  /**
   * 1セルに複数項目が入っているパターンを分解する。
   * @returns {object|null} { bankCode, branchCode, depositType, accountNo, bankName, branchName, name, kana } のうち判明した項目
   */
  function splitCell(v) {
    const s = toHalf(v).trim();
    if (!s) return null;
    let m;
    // 0005-001 / 0005 001 / 0005/001（銀行コード＋支店コード）
    if ((m = s.match(/^(\d{4})[\s\-/／]+(\d{3})$/))) return { bankCode: m[1], branchCode: m[2] };
    // 0005-001-1234567（銀行・支店・口座）
    if ((m = s.match(/^(\d{4})[\s\-/／]+(\d{3})[\s\-/／]+(\d{5,8})$/))) return { bankCode: m[1], branchCode: m[2], accountNo: m[3] };
    // 普通 1234567 / 当座1234567 / 普1234567 / 1-1234567
    if ((m = s.match(/^(普通|当座|貯蓄|普|当|ﾌﾂｳ|ﾄｳｻﾞ|フツウ|トウザ)[\s\-:：]*(\d{5,8})$/))) return { depositType: m[1], accountNo: m[2] };
    if ((m = s.match(/^([124])[\s\-:：]+(\d{5,8})$/))) return { depositType: m[1], accountNo: m[2] };
    // 三菱UFJ銀行 渋谷支店 / みずほ銀行渋谷支店 / 京都信用金庫 本店営業部
    if ((m = s.match(/^(.+?(?:銀行|信用金庫|信金|信用組合|信組|労働金庫|労金|農協|ＪＡ|JA))[\s　]*(.*?(?:支店|本店営業部|営業部|出張所|支所|本店))$/))) return { bankName: m[1], branchName: m[2].trim() };
    // 山田太郎（ヤマダタロウ） / 山田 太郎(ヤマダ タロウ)
    if ((m = s.match(/^(.+?)[\s　]*[（(]([^()（）]+)[)）]$/)) && kanaRatio(m[2]) > 0.6) return { name: m[1], kana: m[2] };
    return null;
  }

  /**
   * 表全体を走査し、分解できる列があれば仮想列を右に追加する。
   * @returns { table, headers, notes[] }  headers は仮想列の見出しを含む
   */
  function expandTable(table, headerIdx) {
    const headers = (table[headerIdx] || []).slice();
    const rows = table.slice(headerIdx + 1);
    const width = Math.max(headers.length, ...rows.map((r) => r.length));
    const notes = [];
    const virtual = []; // { srcCol, part, header }
    for (let c = 0; c < width; c++) {
      const vals = rows.map((r) => r[c]).filter((v) => v != null && String(v).trim() !== '');
      if (vals.length < 1) continue;
      const parts = {};
      let hit = 0;
      for (const v of vals) { const p = splitCell(v); if (p) { hit++; for (const k of Object.keys(p)) parts[k] = (parts[k] || 0) + 1; } }
      if (hit / vals.length < 0.6) continue; // 6割以上の行で同じ分解ができるときだけ
      const label = headers[c] || `列${c + 1}`;
      const partNames = { bankCode: '銀行コード', branchCode: '支店コード', accountNo: '口座番号', depositType: '預金種目', bankName: '銀行名', branchName: '支店名', name: '氏名', kana: 'カナ' };
      for (const k of Object.keys(parts)) virtual.push({ srcCol: c, part: k, header: `${label}→${partNames[k]}` });
      notes.push(`「${label}」列は1セルに複数の項目が入っているので、${Object.keys(parts).map((k) => partNames[k]).join('・')}に分けました`);
    }
    const sourceCols = [...new Set(virtual.map((v) => v.srcCol))];
    if (!virtual.length) return { table, headers, notes, sourceCols };
    const newHeaders = headers.slice();
    while (newHeaders.length < width) newHeaders.push('');
    for (const v of virtual) newHeaders.push(v.header);
    const newTable = table.map((r, i) => {
      const row = r.slice();
      while (row.length < width) row.push('');
      if (i <= headerIdx) { for (const v of virtual) row.push(i === headerIdx ? v.header : ''); return row; }
      for (const v of virtual) { const p = splitCell(r[v.srcCol]); row.push(p && p[v.part] != null ? p[v.part] : ''); }
      return row;
    });
    return { table: newTable, headers: newHeaders, notes, sourceCols };
  }

  // ---- 列の「値の形」判定 ----------------------------------------------------
  /**
   * @returns {{type:string, score:number}} type: code4|code3|account|amount|kana|kanjiName|bankText|branchText|deposit|id|text|empty
   */
  function profileColumn(values) {
    const vals = values.map((v) => (v == null ? '' : String(v).trim())).filter(Boolean).slice(0, 200);
    if (!vals.length) return { type: 'empty', score: 0 };
    const n = vals.length;
    const ratio = (fn) => vals.filter(fn).length / n;
    const allDigits = ratio((v) => /^\d+$/.test(digitsOnly(v)) && digitsOnly(v) === toHalf(v).replace(/[\s\-]/g, ''));
    const lens = vals.map((v) => digitsOnly(v).length);
    const maxLen = Math.max(...lens);
    const r = {};
    r.deposit = ratio((v) => DEPOSIT_RE.test(toHalf(v)));
    r.bankText = ratio((v) => BANK_WORD_RE.test(v) && !BRANCH_WORD_RE.test(v));
    r.branchText = ratio((v) => BRANCH_WORD_RE.test(v));
    r.kana = ratio((v) => kanaRatio(v) >= 0.7 && !BANK_WORD_RE.test(v) && !BRANCH_WORD_RE.test(v));
    r.kanjiName = ratio((v) => KANJI_RE.test(v) && !BANK_WORD_RE.test(v) && !BRANCH_WORD_RE.test(v) && [...v].length <= 20);
    r.amount = ratio((v) => isAmountLike(v) && /[,¥￥円]/.test(toHalf(v)) || (isAmountLike(v) && Number(toHalf(v).replace(/[,，¥￥\s円]/g, '')) >= 1000));
    if (allDigits >= 0.9) {
      const distinct = new Set(vals.map(digitsOnly)).size;
      if (maxLen <= 4 && ratio((v) => digitsOnly(v).length === 4 || (digitsOnly(v).length < 4 && v.startsWith('0') === false)) >= 0.8 && maxLen === 4) return { type: 'code4', score: 0.9 };
      if (maxLen <= 3 && ratio((v) => digitsOnly(v).length >= 1) >= 0.9 && distinct > 1) return { type: 'code3', score: 0.8 };
      if (maxLen <= 3) return { type: 'code3', score: 0.5 };
      if (maxLen <= 8 && ratio((v) => digitsOnly(v).length >= 5) >= 0.7) {
        // 口座番号と金額の区別: 金額は下2桁が00になりやすく、口座番号は先頭0や7桁固定が多い
        const round = ratio((v) => /00$/.test(digitsOnly(v)));
        const lead0 = ratio((v) => /^0/.test(digitsOnly(v)));
        const len7 = ratio((v) => digitsOnly(v).length === 7);
        if (lead0 >= 0.2 || len7 >= 0.8) return { type: 'account', score: 0.85 };
        if (round >= 0.6) return { type: 'amount', score: 0.6 };
        return { type: 'account', score: 0.6 };
      }
      if (r.amount >= 0.7) return { type: 'amount', score: 0.7 };
      return { type: 'id', score: 0.4 };
    }
    const best = Object.entries(r).sort((a, b) => b[1] - a[1])[0];
    if (best[1] >= 0.7) return { type: best[0], score: best[1] };
    if (r.amount >= 0.5) return { type: 'amount', score: 0.5 };
    return { type: 'text', score: 0.2 };
  }

  // ---- 見出し行の推定 ------------------------------------------------------
  function detectHeaderRow(table) {
    const aliases = FIELDS.flatMap((f) => f.aliases.map(normHeader));
    let best = -1, bestScore = 0;
    for (let i = 0; i < Math.min(table.length, 30); i++) {
      const cells = (table[i] || []).map(normHeader).filter(Boolean);
      if (cells.length < 3) continue;
      const hit = cells.filter((c) => aliases.some((a) => c === a || c.includes(a))).length;
      // 見出し行はほとんどが文字で、数値がほぼ無い
      const numeric = cells.filter((c) => /^[\d,.¥￥円-]+$/.test(c)).length;
      const score = hit * 2 + (numeric === 0 ? 1 : -numeric);
      if (score > bestScore) { bestScore = score; best = i; }
      if (hit >= 4) break;
    }
    return { headerIdx: best, hasHeader: best >= 0 && bestScore >= 3 };
  }

  // ---- 割り当て ------------------------------------------------------------
  /**
   * 見出し名 → 値の形 の順で全銀項目に割り当てる。
   * @param {string[][]} table  expandTable 後の表
   * @param {number} headerIdx  見出し行（無い場合は -1: 先頭行からデータ）
   * @param {string} kind       '21'|'11'|'12'
   * @returns {{ mapping: {key:number}, info: {key:{method:'header'|'inferred', reason:string, confidence:number}}, columns:[{index, header, profile}] }}
   */
  function suggestMapping(table, headerIdx, kind, opts) {
    opts = opts || {};
    const headers = headerIdx >= 0 ? (table[headerIdx] || []) : [];
    const rows = table.slice(headerIdx + 1).filter((r) => r.some((c) => c !== '' && c != null));
    const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
    const columns = [];
    for (let c = 0; c < width; c++) columns.push({ index: c, header: headers[c] || '', profile: profileColumn(rows.map((r) => r[c])) });
    const fields = FIELDS.filter((f) => !f.kinds || f.kinds.includes(kind));
    const mapping = {}, info = {}, used = new Set(opts.skipCols || []); // 分解元の列はそのまま使わない

    // 1) 見出し名
    const cands = [];
    fields.forEach((f) => f.aliases.forEach((alias) => {
      const a = normHeader(alias);
      columns.forEach((col) => {
        const h = normHeader(String(col.header).split('→').pop()); // 仮想列「元→項目」は項目名だけで照合
        if (!h) return;
        if (h === a) cands.push({ key: f.key, ci: col.index, score: 1000 + a.length });
        else if (h.includes(a)) cands.push({ key: f.key, ci: col.index, score: a.length });
      });
    }));
    cands.sort((x, y) => y.score - x.score);
    for (const c of cands) {
      if (mapping[c.key] != null || used.has(c.ci)) continue;
      // 見出しが合っていても中身が明らかに違う列は採らない（例: 「銀行」列に銀行名が入っている → bankCode ではなく bankName）
      const p = columns[c.ci].profile;
      if (c.key === 'bankCode' && ['bankText', 'kanjiName', 'kana'].includes(p.type)) continue;
      if (c.key === 'branchCode' && ['branchText', 'kanjiName', 'kana'].includes(p.type)) continue;
      if (c.key === 'name' && ['amount', 'code4', 'code3', 'account', 'bankText', 'branchText', 'deposit'].includes(p.type)) continue;
      if ((c.key === 'bankName' || c.key === 'branchName') && ['amount', 'code4', 'code3', 'account', 'kana', 'deposit'].includes(p.type)) continue;
      if (c.key === 'amount' && ['kana', 'kanjiName', 'bankText', 'branchText'].includes(p.type)) continue;
      mapping[c.key] = c.ci; used.add(c.ci);
      info[c.key] = { method: 'header', reason: `見出し「${columns[c.ci].header}」`, confidence: 1 };
    }

    // 2) 値の形（見出しで決まらなかった項目だけ）
    const pick = (key, types, extra) => {
      if (mapping[key] != null) return;
      const list = columns.filter((col) => !used.has(col.index) && types.includes(col.profile.type));
      if (!list.length) return;
      let chosen = list[0];
      if (extra) chosen = extra(list) || chosen;
      mapping[key] = chosen.index; used.add(chosen.index);
      const label = { code4: '4桁の数字', code3: '3桁の数字', account: '5〜8桁の数字', amount: '金額らしい数値', kana: 'カナの文字列', kanjiName: '氏名らしい文字列', bankText: '「銀行」等を含む文字列', branchText: '「支店」等を含む文字列', deposit: '普通／当座' }[chosen.profile.type];
      info[key] = { method: 'inferred', reason: `値の形から推定（${label}）`, confidence: Math.min(0.8, chosen.profile.score) * (list.length > 1 ? 0.7 : 1) };
    };
    pick('bankCode', ['code4']);
    pick('branchCode', ['code3']);
    pick('accountNo', ['account']);
    pick('name', ['kana'], (list) => list.find((c) => /カナ|かな|フリガナ|ふりがな/.test(c.header)) || list[list.length - 1]);
    pick('amount', ['amount'], (list) => list.find((c) => /差引|振込|支給|支払|手取/.test(c.header)) || list[list.length - 1]);
    pick('depositType', ['deposit']);
    pick('bankName', ['bankText']);
    pick('branchName', ['branchText']);
    // 受取人名がカナ列で決まらなければ漢字名を仮に当てる（後で辞書やカナ列で補う）
    pick('name', ['kanjiName'], (list) => list.find((c) => /氏名|名前|名義|受取|支払先|取引先/.test(c.header)) || list[0]);

    return { mapping, info, columns };
  }

  // ---- 合計行など ----------------------------------------------------------
  function isTotalRow(row, mapping) {
    const nameCell = mapping.name != null ? String(row[mapping.name] || '').trim() : '';
    const anyTotalWord = row.some((c) => TOTAL_RE.test(toHalf(String(c || '')).trim()));
    const acct = mapping.accountNo != null ? digitsOnly(row[mapping.accountNo]) : '';
    return anyTotalWord && !acct || (!nameCell && !acct && mapping.amount != null && isAmountLike(row[mapping.amount] || ''));
  }

  /** 全部まとめて実行 */
  function analyze(rawTable, kind, forcedHeaderIdx) {
    const table0 = rawTable.map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
    const det = detectHeaderRow(table0);
    const headerIdx = forcedHeaderIdx != null ? forcedHeaderIdx : (det.hasHeader ? det.headerIdx : -1);
    const ex = expandTable(table0, Math.max(headerIdx, 0));
    let table = ex.table;
    if (headerIdx < 0) {
      // 見出しが無い: 仮想見出し行を先頭に挿入する（表示・割り当ての都合）
      const width = Math.max(...table.map((r) => r.length));
      const vh = Array.from({ length: width }, (_, i) => (ex.headers[i] || `列${i + 1}`));
      table = [vh, ...table];
    }
    const hIdx = headerIdx < 0 ? 0 : headerIdx;
    const sug = suggestMapping(table, hIdx, kind, { skipCols: ex.sourceCols });
    const notes = ex.notes.slice();
    if (headerIdx < 0) notes.push('見出し行が見つからなかったので、値の形から列を推定しました。割り当てを必ず確認してください');
    return { table, headerIdx: hIdx, hasHeader: headerIdx >= 0, mapping: sug.mapping, info: sug.info, columns: sug.columns, notes };
  }

  return { FIELDS, normHeader, splitCell, expandTable, profileColumn, detectHeaderRow, suggestMapping, isTotalRow, analyze, toHalf };
});
