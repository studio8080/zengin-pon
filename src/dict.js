/* dict.js — 金融機関辞書（data/ 配下。tools/build-dict.js で生成） */
(function () {
  'use strict';
  const base = '/data/'; // ルート相対。/tools/ や /banks/ 配下のページからも同じ辞書を読めるようにする
  const cache = { banks: null, branches: new Map(), merged: null, version: '' };
  const pending = new Map();

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
    // 同じ銀行を同時に何行も調べるので、読み込み中の分は使い回す（同じファイルを何度も取りに行かない）
    if (!pending.has(bankCode)) {
      pending.set(bankCode, getJSON(`branches/${bankCode}.json`).catch(() => null).then((data) => {
        cache.branches.set(bankCode, data);
        pending.delete(bankCode);
        return data;
      }));
    }
    return pending.get(bankCode);
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
    name = hira2kata(String(name));
    if (/信用金庫|信金|シンキン|シンヨウキンコ/.test(name)) return (c) => c >= '1000' && c <= '1999';
    if (/信用組合|信組/.test(name)) return (c) => c >= '2000' && c <= '2950';
    if (/労働金庫|労金/.test(name)) return (c) => c >= '2951' && c <= '2999';
    if (/農業協同組合|農協|JA|漁協|漁業協同組合/.test(toHalf(name)) ) return (c) => c >= '3000' && c <= '9899';
    if (/ゆうちょ/.test(name)) return (c) => c === '9900';
    if (/銀行/.test(name)) return (c) => c < '1000' || c === '9900';
    return () => true;
  }
  function stripSuffix(name) {
    return hira2kata(toHalf(name).normalize('NFKC')).trim().replace(/[\s　]+/g, '').replace(/(銀行|ギンコウ|信用金庫|信金|シンヨウキンコ|シンキン|信用組合|信組|シンクミ|労働金庫|労金|ロウキン|農業協同組合|農協|漁業協同組合|漁協)$/u, '').replace(/^(株式会社|\(株\)|（株）)/u, '').trim();
  }
  // 改称した銀行の旧名（社内の表には旧名のまま残っていることが多い）。コードは変わっていない。
  const FORMER_NAMES = {
    '住信SBIネット': '0038', 'ジャパンネット': '0033', 'じぶん': '0039', 'auじぶん': '0039', '新生': '0397',
    '三菱東京UFJ': '0005', '東京三菱': '0005', '三菱UFJ': '0005', 'UFJ': '0005', '郵便局': '9900', 'ゆうちょ': '9900',
  };
  /** @returns {{code, name, kana, exact:boolean}[]} 候補（先頭が最有力） */
  function findBank(input) {
    if (!cache.banks || !input) return [];
    const inCat = categoryOf(String(input));
    const q = normName(stripSuffix(input));
    if (!q) return [];
    for (const [former, code] of Object.entries(FORMER_NAMES)) {
      const b = cache.banks[code];
      if (b && normName(former) === q) return [{ code, name: b[0], kana: b[1], exact: true, formerName: true }];
    }
    const exact = [], partial = [];
    for (const [code, [name, kana]] of Object.entries(cache.banks)) {
      if (!inCat(code)) continue;
      const n = normName(name), k = normName(kana);
      // 辞書の名前は「京都信金」のように略称つき。入力と同じく末尾の種別を外して比べないと、
      // 「京都信用金庫」が京都信金・京都中央信金・京都北都信金の3候補になってしまう
      const ns = normName(stripSuffix(name)), ks = normName(String(kana).replace(/(ギンコウ|シンキン|シンクミ|ロウキン|ノウキヨウ)$/u, ''));
      if (n === q || k === q || ns === q || ks === q) exact.push({ code, name, kana, exact: true });
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
