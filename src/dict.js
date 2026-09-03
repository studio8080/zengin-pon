/* dict.js — 金融機関辞書（data/ 配下。tools/build-dict.js で生成） */
(function () {
  'use strict';
  const base = 'data/';
  const cache = { banks: null, branches: new Map(), merged: null, version: '' };

  async function getJSON(path) {
    const res = await fetch(base + path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function load() {
    if (cache.banks) return cache;
    const [banks, merged] = await Promise.all([
      getJSON('banks.json'),
      getJSON('merged.json').catch(() => ({ merged: [] })),
    ]);
    cache.banks = banks.banks; cache.version = banks.version;
    cache.merged = (merged.merged || []).filter((m) => !m.example);
    return cache;
  }

  /** @returns {[name, kana]|null} */
  function bank(code) { return (cache.banks && cache.banks[code]) || null; }

  async function branches(bankCode) {
    if (!cache.banks || !cache.banks[bankCode]) return null;
    if (cache.branches.has(bankCode)) return cache.branches.get(bankCode);
    let data = null;
    try { data = await getJSON(`branches/${bankCode}.json`); } catch (_) { data = null; }
    cache.branches.set(bankCode, data);
    return data;
  }

  /** @returns {[name, kana]|null|undefined} undefined = 支店一覧が未取得 */
  function branch(bankCode, branchCode) {
    const b = cache.branches.get(bankCode);
    if (b == null) return undefined;
    return (b && b[branchCode]) || null;
  }

  function mergedInfo(bankCode) { return (cache.merged || []).find((m) => m.old === bankCode) || null; }

  // ---- 名前からコードを逆引き --------------------------------------------
  const toHalf = (s) => String(s == null ? '' : s).replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const hira2kata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const SMALL = { 'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ' };
  function normName(s) {
    return hira2kata(toHalf(s).normalize('NFKC')).toUpperCase()
      .replace(/[\s　・･\-－ー―‐]/g, '').replace(/[ァィゥェォッャュョ]/g, (c) => SMALL[c]);
  }
  // 金融機関の種別 → コード帯（全銀協の割り当て）
  function categoryOf(name) {
    if (/信用金庫|信金/.test(name)) return (c) => c >= '1000' && c <= '1999';
    if (/信用組合|信組/.test(name)) return (c) => c >= '2000' && c <= '2950';
    if (/労働金庫|労金/.test(name)) return (c) => c >= '2951' && c <= '2999';
    if (/農業協同組合|農協|JA|漁協|漁業協同組合/.test(toHalf(name)) ) return (c) => c >= '3000' && c <= '9899';
    if (/ゆうちょ/.test(name)) return (c) => c === '9900';
    if (/銀行/.test(name)) return (c) => c < '1000' || c === '9900';
    return () => true;
  }
  function stripSuffix(name) {
    return toHalf(name).trim().replace(/(銀行|信用金庫|信金|信用組合|信組|労働金庫|労金|農業協同組合|農協|漁業協同組合|漁協)$/u, '').replace(/^(株式会社|\(株\)|（株）)/u, '').trim();
  }
  /** @returns {{code, name, kana, exact:boolean}[]} 候補（先頭が最有力） */
  function findBank(input) {
    if (!cache.banks || !input) return [];
    const inCat = categoryOf(String(input));
    const q = normName(stripSuffix(input));
    if (!q) return [];
    const exact = [], partial = [];
    for (const [code, [name, kana]] of Object.entries(cache.banks)) {
      if (!inCat(code)) continue;
      const n = normName(name), k = normName(kana);
      if (n === q || k === q) exact.push({ code, name, kana, exact: true });
      else if (q.length >= 2 && (n.startsWith(q) || k.startsWith(q) || q.startsWith(n))) partial.push({ code, name, kana, exact: false });
    }
    return exact.concat(partial);
  }
  /** 支店名 → 支店コード候補（branches(bankCode) を先に読んでおくこと） */
  function findBranch(bankCode, input) {
    const list = cache.branches.get(bankCode);
    if (!list || !input) return [];
    const q = normName(toHalf(input).trim().replace(/(支店|出張所|支所)$/u, ''));
    if (!q) return [];
    const exact = [], partial = [];
    for (const [code, [name, kana]] of Object.entries(list)) {
      const n = normName(name.replace(/(支店|出張所|支所)$/u, '')), k = normName(kana);
      if (n === q || k === q) exact.push({ code, name, kana, exact: true });
      else if (q.length >= 2 && (n.startsWith(q) || k.startsWith(q))) partial.push({ code, name, kana, exact: false });
    }
    return exact.concat(partial);
  }

  window.BankDict = { load, bank, branches, branch, mergedInfo, findBank, findBranch, get version() { return cache.version; }, get loaded() { return !!cache.banks; } };
})();
