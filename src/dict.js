/* dict.js — 金融機関辞書（data/ 配下。tools/build-dict.js・tools/build-history.js で生成）と、
 * 表に書かれた銀行名・支店名・コードの照合。
 *
 * 方針: 確実なもの（正式名・カナ・ローマ字の完全一致、履歴にある旧名）だけを自動で補う。
 * 部分一致・1〜2文字違い・コードと名前の食い違い・一覧から消えたコードは「要確認」にして候補を示す。
 * 似た名前の支店（金沢／金沢駅前）を黙って選ぶと、振込先を取り違えるおそれがあるため。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BankDict = api;
})(this, function () {
  'use strict';
  let base = '/data/'; // ルート相対。/free-tools/ や /banks/ 配下のページからも同じ辞書を読めるようにする
  let fetchJSON = async (path) => {
    const res = await fetch(base + path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  };
  /** テスト用: 読み込み方を差し替える */
  function setLoader(fn) { fetchJSON = fn; }

  const cache = { banks: null, branches: new Map(), history: new Map(), merged: null, version: '', bankHistory: null };
  const pending = new Map();
  const once = (key, fn) => {
    if (!pending.has(key)) pending.set(key, fn().finally(() => pending.delete(key)));
    return pending.get(key);
  };

  async function load() {
    if (cache.banks) return cache;
    const [banks, merged, hist] = await Promise.all([
      fetchJSON('banks.json'),
      fetchJSON('merged.json').catch(() => ({ merged: [] })),
      fetchJSON('history/banks.json').catch(() => null),
    ]);
    cache.banks = banks.banks; cache.version = banks.version;
    cache.merged = (merged.merged || []).filter((m) => !m.example);
    cache.bankHistory = hist;
    buildBankAliases();
    return cache;
  }

  /** @returns {[name, kana]|null} */
  function bank(code) { return (cache.banks && cache.banks[code]) || null; }

  async function branches(bankCode) {
    if (!cache.banks || !cache.banks[bankCode]) return null;
    if (cache.branches.has(bankCode)) return cache.branches.get(bankCode);
    // 同じ銀行を同時に何行も調べるので、読み込み中の分は使い回す（同じファイルを何度も取りに行かない）
    return once('br' + bankCode, () => fetchJSON(`branches/${bankCode}.json`).catch(() => null).then((data) => {
      cache.branches.set(bankCode, data); return data;
    }));
  }
  /** 支店の履歴（消えた・名前が変わった・番号が変わった）。無い銀行は {} */
  async function branchHistory(bankCode) {
    if (cache.history.has(bankCode)) return cache.history.get(bankCode);
    const has = cache.bankHistory && (cache.bankHistory.branchFiles || []).includes(bankCode);
    if (!has) { cache.history.set(bankCode, {}); return {}; }
    return once('hi' + bankCode, () => fetchJSON(`history/${bankCode}.json`).catch(() => ({})).then((data) => {
      cache.history.set(bankCode, data || {}); return data || {};
    }));
  }

  /** @returns {[name, kana]|null|undefined} undefined = 支店一覧が未取得 */
  function branch(bankCode, branchCode) {
    const b = cache.branches.get(bankCode);
    if (b == null) return undefined;
    return (b && b[branchCode]) || null;
  }

  function mergedInfo(bankCode) { return (cache.merged || []).find((m) => m.old === bankCode) || null; }

  // ------------------------------------------------------------------
  // 表記の正規化
  // ------------------------------------------------------------------
  const SMALL = { 'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ', 'ヵ': 'カ', 'ヶ': 'ケ' };
  /** 全角・半角、ひらがな、大文字小文字をそろえる（空白は残す） */
  function unify(s) {
    return String(s == null ? '' : s).normalize('NFKC').replace(/[​-‍﻿]/g, '')
      .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)).toUpperCase().trim();
  }
  /** 照合用のキー。空白・記号・長音を除き、小さいカナを大きく、ヂヅヲを読みでそろえる */
  function normName(s) {
    return unify(s).replace(/[\s・･.,\-－ー―‐−()（）「」｢｣'"]/g, '')
      .replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL[c]).replace(/ヂ/g, 'ジ').replace(/ヅ/g, 'ズ').replace(/ヲ/g, 'オ');
  }
  /** カナの長音の揺れをつぶしたキー（キヨウト／キヨト、トウキヨウ／トキヨ） */
  function loose(k) {
    return normName(k).replace(/([オコソトノホモヨロゴゾドボポ])[ウオ]/g, '$1').replace(/([ウクスツヌフムユルグズブプ])ウ/g, '$1')
      .replace(/([エケセテネヘメレゲゼデベペ])イ/g, '$1').replace(/([アカサタナハマヤラワガザダバパ])ア/g, '$1');
  }

  // ローマ字 → カタカナ（ヘボン式・訓令式のどちらも）。英字だけの入力に使う
  const ROMA = (() => {
    const t = {};
    const rows = { '': 'アイウエオ', k: 'カキクケコ', s: 'サシスセソ', t: 'タチツテト', n: 'ナニヌネノ', h: 'ハヒフヘホ', m: 'マミムメモ', y: 'ヤイユエヨ', r: 'ラリルレロ', w: 'ワイウエヲ', g: 'ガギグゲゴ', z: 'ザジズゼゾ', d: 'ダヂヅデド', b: 'バビブベボ', p: 'パピプペポ', l: 'ラリルレロ', v: 'ヴィヴヴェヴォ' };
    for (const [c, kana] of Object.entries(rows)) 'aiueo'.split('').forEach((v, i) => { t[c + v] = c === 'v' ? ['ヴァ', 'ヴィ', 'ヴ', 'ヴェ', 'ヴォ'][i] : kana[i]; });
    Object.assign(t, {
      shi: 'シ', chi: 'チ', tsu: 'ツ', fu: 'フ', ji: 'ジ', si: 'シ', ti: 'チ', tu: 'ツ', hu: 'フ', zi: 'ジ', di: 'ヂ', du: 'ヅ', wo: 'ヲ',
      sha: 'シャ', shu: 'シュ', sho: 'ショ', she: 'シェ', cha: 'チャ', chu: 'チュ', cho: 'チョ', che: 'チェ', ja: 'ジャ', ju: 'ジュ', jo: 'ジョ', je: 'ジェ',
      fa: 'ファ', fi: 'フィ', fe: 'フェ', fo: 'フォ', ti_: 'ティ', di_: 'ディ',
    });
    for (const c of 'kgnhbpmrszdtj') for (const [v, s] of [['a', 'ャ'], ['u', 'ュ'], ['o', 'ョ']]) {
      const head = { k: 'キ', g: 'ギ', n: 'ニ', h: 'ヒ', b: 'ビ', p: 'ピ', m: 'ミ', r: 'リ', s: 'シ', z: 'ジ', d: 'ヂ', t: 'チ', j: 'ジ' }[c];
      t[c + 'y' + v] = head + s;
    }
    return t;
  })();
  function romajiToKana(input) {
    let s = String(input).toLowerCase().replace(/[^a-z]/g, '');
    let out = '';
    while (s) {
      if (s.length > 1 && s[0] === s[1] && !'aiueon'.includes(s[0])) { out += 'ッ'; s = s.slice(1); continue; }     // 促音
      if (s[0] === 'n' && (s.length === 1 || !'aiueoy'.includes(s[1]))) { out += 'ン'; s = s.slice(s[1] === "'" ? 2 : 1); continue; }
      if (s[0] === 'm' && 'bpm'.includes(s[1] || '')) { out += 'ン'; s = s.slice(1); continue; }                     // shimbashi
      let hit = false;
      for (const len of [3, 2, 1]) {
        const k = s.slice(0, len);
        if (ROMA[k]) { out += ROMA[k]; s = s.slice(len); hit = true; break; }
      }
      if (!hit) { s = s.slice(1); }
    }
    return out;
  }
  const isLatin = (s) => /^[A-Z0-9\s.&'-]+$/.test(unify(s)) && /[A-Z]/.test(unify(s));

  // 銀行名・支店名の末尾の種別（照合では外す）
  const BANK_SUFFIX = /(銀行|ギンコウ|信用金庫|信金|シンヨウキンコ|シンキン|信用組合|信組|シンクミ|労働金庫|労金|ロウキン|農業協同組合|農協|漁業協同組合|漁協|BANK|BK|GINKOU?|SHINKIN|SHINYOKINKO|SHINKUMI|ROKIN)$/u;
  const BANK_PREFIX = /^(株式会社|\(株\)|THE|株式会社)/u;
  function stripBank(name) {
    let s = unify(name).replace(/[,.&'’]/g, ' ').replace(/[\s　]+/g, ' ').trim();
    s = s.replace(/^THE\s+/, '').replace(/^BANK OF\s+/, '').replace(/\s+(CO|CORP|LTD|LIMITED|INC)\.?$/g, '');
    s = s.replace(/\s+/g, '').replace(BANK_PREFIX, '');
    for (let i = 0; i < 2; i++) s = s.replace(BANK_SUFFIX, '');
    return s;
  }
  const BRANCH_SUFFIX = /(支店|出張所|支所|SHITEN|BRANCH|BR|OFFICE|SHUCCHOJO)$/u;
  function stripBranch(name) { return unify(name).replace(/[\s　]+/g, '').replace(BRANCH_SUFFIX, '').replace(/^(本店)?(営業部)$/u, '$1$2'); }
  /** 照合キーの組（漢字名の正規形、カナ／ローマ字から作ったカナ） */
  function keysOf(input, strip) {
    const s = strip(input);
    const latin = isLatin(input);
    const kana = latin ? normName(romajiToKana(s)) : normName(s);
    return { n: normName(s), kana, latin };
  }

  // 1〜2文字違い（書き間違い）の判定
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0]; prev[0] = i; let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp; rowMin = Math.min(rowMin, prev[j]);
      }
      if (rowMin > max) return max + 1;
    }
    return prev[b.length];
  }
  const fuzzyMax = (q) => (q.length >= 6 ? 2 : q.length >= 3 ? 1 : 0);

  // ------------------------------------------------------------------
  // 金融機関の別名（英語名・通称・旧名）
  // ------------------------------------------------------------------
  // 英語名・通称 → 辞書の名前（コードは辞書から引く。コードを直書きしない）
  const EN_ALIASES = {
    'MIZUHO': 'みずほ', 'MUFG': '三菱ＵＦＪ', 'MITSUBISHIUFJ': '三菱ＵＦＪ', 'BTMU': '三菱ＵＦＪ', 'BANKOFTOKYOMITSUBISHIUFJ': '三菱ＵＦＪ',
    'SMBC': '三井住友', 'SUMITOMOMITSUI': '三井住友', 'SUMITOMOMITSUIBANKINGCORPORATION': '三井住友',
    'RESONA': 'りそな', 'SAITAMARESONA': '埼玉りそな', 'JAPANPOST': 'ゆうちょ', 'JAPANPOSTBANK': 'ゆうちょ', 'YUCHO': 'ゆうちょ', 'JPBANK': 'ゆうちょ',
    'PAYPAY': 'ＰａｙＰａｙ', 'RAKUTEN': '楽天', 'SONY': 'ソニー', 'SEVEN': 'セブン', 'AEON': 'イオン', 'LAWSON': 'ローソン',
    'AUJIBUN': 'ａｕじぶん', 'JIBUN': 'ａｕじぶん', 'SBISHINSEI': 'ＳＢＩ新生', 'SHINSEI': 'ＳＢＩ新生', 'AOZORA': 'あおぞら',
    'GMOAOZORANET': 'ＧＭＯあおぞらネット', 'GMOAOZORA': 'ＧＭＯあおぞらネット', 'SUMISHINSBINET': 'ドコモＳＭＴＢネット', 'SBINET': 'ドコモＳＭＴＢネット',
    'DOCOMOSMTBNET': 'ドコモＳＭＴＢネット', 'SBISHINSEITRUST': '新生信託', 'SHINSEITRUST': '新生信託', 'SUMITOMOMITSUITRUST': '三井住友信託', 'SMTB': '三井住友信託', 'MITSUBISHIUFJTRUST': '三菱ＵＦＪ信託', 'MIZUHOTRUST': 'みずほ信託',
    'MINNANO': 'みんなの', 'UI': 'ＵＩ', 'SHOKOCHUKIN': '商工中金', 'NORINCHUKIN': '農林中金',
    // 改称・通称（日本語）
    '住信SBIネット': 'ドコモＳＭＴＢネット', 'ジャパンネット': 'ＰａｙＰａｙ', 'じぶん': 'ａｕじぶん', '新生': 'ＳＢＩ新生', 'SBI新生信託': '新生信託',
    '三菱東京UFJ': '三菱ＵＦＪ', '東京三菱': '三菱ＵＦＪ', 'UFJ': '三菱ＵＦＪ', '郵便局': 'ゆうちょ', 'ゆうちょ': 'ゆうちょ', 'ペイペイ': 'ＰａｙＰａｙ',
  };
  let aliasIndex = new Map();   // 正規化キー → [{code, via}]
  function addAlias(key, code, via) {
    if (!key) return;
    const list = aliasIndex.get(key) || [];
    if (!list.some((x) => x.code === code)) list.push({ code, via });
    aliasIndex.set(key, list);
  }
  function buildBankAliases() {
    aliasIndex = new Map();
    const byName = new Map(Object.entries(cache.banks).map(([c, [n]]) => [normName(n), c]));
    for (const [alias, name] of Object.entries(EN_ALIASES)) {
      const code = byName.get(normName(name));
      if (code) addAlias(normName(stripBank(alias)), code, `「${alias}」は ${name} の別名`);
    }
    // 履歴にある改称前の名前（例: 札幌信金 → 北海道信金）
    const hist = cache.bankHistory && cache.bankHistory.banks;
    if (hist) for (const [code, evs] of Object.entries(hist)) for (const e of evs) {
      if (e.t === 'renamed' && e.was && cache.banks[code]) addAlias(normName(stripBank(e.was)), code, `${e.d.slice(0, 7)} に「${e.was}」から「${e.name}」へ改称`);
    }
  }

  // 金融機関の種別 → コード帯（全銀協の割り当て）
  function categoryOf(name) {
    const s = unify(name).replace(/[\s　]+/g, '');
    if (/信用金庫|信金|シンキン|シンヨウキンコ|SHINKIN/.test(s)) return (c) => c >= '1000' && c <= '1999';
    if (/信用組合|信組|シンクミ|SHINKUMI/.test(s)) return (c) => c >= '2000' && c <= '2950';
    if (/労働金庫|労金|ロウキン|ROKIN/.test(s)) return (c) => c >= '2951' && c <= '2999';
    if (/農業協同組合|農協|JA|漁協|漁業協同組合/.test(s)) return (c) => c >= '3000' && c <= '9899';
    if (/ゆうちょ|ユウチヨ|郵便局/.test(s)) return (c) => c === '9900';
    if (/銀行|BANK/.test(s)) return (c) => c < '1000' || c === '9900';
    return () => true;
  }

  /**
   * 銀行名 → 候補。match は exact（正式名・カナ・ローマ字の一致）／alias（英語名・旧名）／loose（長音の揺れ）／
   * partial（前方一致）／fuzzy（1〜2文字違い）。先頭ほど確か。
   */
  function findBank(input) {
    if (!cache.banks || !input) return [];
    const inCat = categoryOf(input);
    const k = keysOf(input, stripBank);
    if (!k.n) return [];
    const out = new Map();
    const add = (code, match, note) => { if (!out.has(code)) out.set(code, { code, name: cache.banks[code][0], kana: cache.banks[code][1], match, exact: match === 'exact' || match === 'alias', note }); };
    for (const { code, via } of aliasIndex.get(k.n) || []) add(code, 'alias', via);
    const entries = Object.entries(cache.banks).filter(([code]) => inCat(code));
    for (const [code, [name, kana]] of entries) {
      const n = normName(stripBank(name)), kk = normName(stripBank(kana));
      if (n === k.n || kk === k.kana || (k.latin && kk === k.kana)) add(code, 'exact');
    }
    if (!out.size) for (const [code, [, kana]] of entries) { if (loose(stripBank(kana)) === loose(k.kana)) add(code, 'loose', '長音などの表記の揺れ'); }
    if (!out.size && k.n.length >= 2) for (const [code, [name, kana]] of entries) {
      const n = normName(stripBank(name)), kk = normName(stripBank(kana));
      if (n.startsWith(k.n) || kk.startsWith(k.kana) || (k.n.length >= 3 && k.n.startsWith(n) && n.length >= 2)) add(code, 'partial');
    }
    if (!out.size) {
      const max = fuzzyMax(k.kana);
      if (max) for (const [code, [name, kana]] of entries) {
        if (lev(normName(stripBank(name)), k.n, max) <= max || lev(normName(stripBank(kana)), k.kana, max) <= max) add(code, 'fuzzy', '1〜2文字違い');
      }
    }
    return [...out.values()];
  }

  /** 支店名 → 候補（match は findBank と同じ。former は履歴にある旧名、moved は番号が振り直された支店） */
  function findBranch(bankCode, input) {
    const list = cache.branches.get(bankCode);
    if (!list || !input) return [];
    const k = keysOf(input, stripBranch);
    if (!k.n) return [];
    const out = new Map();
    const add = (code, match, note) => { if (list[code] && !out.has(code)) out.set(code, { code, name: list[code][0], kana: list[code][1], match, exact: match === 'exact' || match === 'former', note }); };
    for (const [code, [name, kana]] of Object.entries(list)) {
      const n = normName(stripBranch(name)), kk = normName(kana);
      if (n === k.n || kk === k.kana || n === k.kana) add(code, 'exact');
    }
    // 旧名（同じコードで名前が変わった支店）と、番号の振り直し
    const hist = cache.history.get(bankCode) || {};
    if (!out.size) for (const [code, evs] of Object.entries(hist)) for (const e of evs) {
      if (e.t === 'renamed' && e.was && normName(stripBranch(e.was)) === k.n) add(code, 'former', `${e.d.slice(0, 7)} に「${e.was}」から「${e.name}」へ名前が変わっています`);
      if (e.t === 'moved' && (normName(stripBranch(e.name)) === k.n || normName(e.kana) === k.kana)) add(e.to, 'former', `${e.d.slice(0, 7)} に支店コードが ${code} から ${e.to} に変わっています`);
    }
    if (!out.size) for (const [code, [, kana]] of Object.entries(list)) if (loose(kana) === loose(k.kana)) add(code, 'loose', '長音などの表記の揺れ');
    if (!out.size && k.n.length >= 2) for (const [code, [name, kana]] of Object.entries(list)) {
      const n = normName(stripBranch(name)), kk = normName(kana);
      if (n.startsWith(k.n) || kk.startsWith(k.kana)) add(code, 'partial');
    }
    if (!out.size) {
      const max = fuzzyMax(k.kana);
      if (max) for (const [code, [name, kana]] of Object.entries(list)) {
        if (lev(normName(stripBranch(name)), k.n, max) <= max || lev(normName(kana), k.kana, max) <= max) add(code, 'fuzzy', '1〜2文字違い');
      }
    }
    return [...out.values()];
  }

  /** 名前 n で始まる別の支店（「金沢」に対する「金沢駅前」「金沢中央」など） */
  function similarBranches(bankCode, code) {
    const list = cache.branches.get(bankCode); if (!list || !list[code]) return [];
    const n = normName(stripBranch(list[code][0]));
    if (n.length < 2) return [];
    return Object.entries(list).filter(([c, [name]]) => c !== code && normName(stripBranch(name)).startsWith(n)).map(([c, [name]]) => ({ code: c, name }));
  }

  const fmt = (list, max = 4) => list.slice(0, max).map((x) => `${x.code} ${x.name}`).join(' / ') + (list.length > max ? ` ほか${list.length - max}件` : '');
  const ym = (d) => `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月`;

  /**
   * 表の各行の銀行・支店を照合して、コードを補い、確認が要る点を r._info / r._warn に書く。
   * rows: { bankCode, branchCode, _rawBankName, _rawBranchName, _info: [], _warn: [] }
   */
  async function resolveRows(rows) {
    await load();
    // 1) 銀行名・支店名の欄にコードだけが書かれている（「0005」「001」「店番123」）ときは、コードとして使う
    for (const r of rows) {
      const bn = unify(r._rawBankName), sn = unify(r._rawBranchName).replace(/^(店番|支店コード|支店番号|店番号)[:：]?/, '');
      if (!r.bankCode && /^\d{1,4}$/.test(bn)) { r.bankCode = bn.padStart(4, '0'); r._rawBankName = ''; }
      if (!r.branchCode && /^\d{1,3}$/.test(sn)) { r.branchCode = sn.padStart(3, '0'); r._rawBranchName = ''; }
    }

    // 2) 金融機関
    for (const r of rows) {
      const raw = r._rawBankName;
      if (r.bankCode) {
        const b = bank(r.bankCode);
        if (!b) {
          const ev = cache.bankHistory && (cache.bankHistory.banks[r.bankCode] || []).find((e) => e.t === 'removed');
          const merged = mergedInfo(r.bankCode);
          if (merged) r._warn.push(`銀行コード ${r.bankCode} は ${merged.name}（${merged.date}）で新コード ${merged.new} に変わっています。${merged.branchNote || ''}`);
          else if (ev) r._warn.push(`銀行コード ${r.bankCode}（${ev.name}）は ${ym(ev.d)}に金融機関一覧から外れています。合併などで振込先が変わっていないか、受取人に確認してください`);
          else r._warn.push(`銀行コード ${r.bankCode} は金融機関一覧（${cache.version}版）にありません。入力ミスの可能性があります`);
          continue;
        }
        // コードと銀行名の両方があれば、食い違っていないか確かめる
        if (raw) {
          const c = findBank(raw).filter((x) => x.exact);
          if (c.length && !c.some((x) => x.code === r.bankCode)) r._warn.push(`銀行コード ${r.bankCode} は「${b[0]}」です。表の銀行名「${raw}」は ${fmt(c, 2)} です。どちらが正しいか確認してください`);
        }
        continue;
      }
      if (!raw) continue;
      const c = findBank(raw);
      const best = c.filter((x) => x.exact);
      const pick = best.length ? best : c;
      if (pick.length === 1 && (pick[0].exact || pick[0].match === 'loose')) {
        r.bankCode = pick[0].code;
        r._info.push(`銀行名「${raw}」から銀行コード ${pick[0].code}（${pick[0].name}）を補いました${pick[0].note ? `（${pick[0].note}）` : ''}`);
      } else if (pick.length === 1 && pick[0].match === 'partial') {
        r.bankCode = pick[0].code;
        r._warn.push(`銀行名「${raw}」を ${pick[0].code}（${pick[0].name}）と推定しました。正しいか確認してください`);
      } else if (pick.length && pick[0].match === 'fuzzy') r._warn.push(`銀行名「${raw}」が見つかりません。もしかして: ${fmt(pick)}`);
      else if (pick.length > 1) r._warn.push(`銀行名「${raw}」に候補が複数あります: ${fmt(pick)}`);
      else r._warn.push(`銀行名「${raw}」が金融機関一覧に見つかりません`);
    }

    // 3) 支店（一覧と履歴を読む）
    const codes = [...new Set(rows.map((r) => r.bankCode).filter((c) => c && bank(c)))];
    await Promise.all(codes.map((c) => Promise.all([branches(c), branchHistory(c)])));
    for (const r of rows) {
      if (!r.bankCode || !bank(r.bankCode)) continue;
      const list = cache.branches.get(r.bankCode);
      if (!list) continue;
      const raw = r._rawBranchName;
      const hist = cache.history.get(r.bankCode) || {};
      if (r.branchCode) {
        if (!list[r.branchCode]) {
          const evs = hist[r.branchCode] || [];
          const moved = evs.filter((e) => e.t === 'moved').pop(), removed = evs.filter((e) => e.t === 'removed').pop();
          if (moved && list[moved.to]) {
            r._warn.push(`支店コード ${r.branchCode}（${moved.name}）は ${ym(moved.d)}に ${moved.to}（${list[moved.to][0]}）へ番号が変わっています。新しいコード ${moved.to} で出力します。受取人の口座が移っているか確認してください`);
            r.branchCode = moved.to;
          } else if (removed) {
            const same = Object.entries(list).filter(([, [n]]) => normName(stripBranch(n)) === normName(stripBranch(removed.name))).map(([code, [name]]) => ({ code, name }));
            r._warn.push(`支店コード ${r.branchCode}（${removed.name}）は ${ym(removed.d)}に支店一覧から外れています（統廃合の可能性）。${same.length ? `同じ名前の支店: ${fmt(same)}。` : ''}受取人に新しい支店を確認してください`);
          } else r._warn.push(`支店コード ${r.branchCode} は ${bank(r.bankCode)[0]}の支店一覧にありません`);
          continue;
        }
        // コードと支店名の両方があれば、食い違っていないか確かめる（金沢／金沢駅前の取り違えなど）
        if (raw) {
          const c = findBranch(r.bankCode, raw);
          const ok = c.some((x) => x.code === r.branchCode && (x.exact || x.match === 'loose'));
          if (!ok) {
            const exact = c.filter((x) => x.exact);
            r._warn.push(`支店コード ${r.branchCode} は「${list[r.branchCode][0]}」です。表の支店名「${raw}」${exact.length ? `は ${fmt(exact, 2)} です` : 'と一致しません'}。どちらが正しいか確認してください`);
          }
        }
        continue;
      }
      if (!raw) continue;
      const c = findBranch(r.bankCode, raw);
      const best = c.filter((x) => x.exact);
      const pick = best.length ? best : c;
      if (pick.length === 1 && (pick[0].exact || pick[0].match === 'loose')) {
        r.branchCode = pick[0].code;
        const msg = `支店名「${raw}」から支店コード ${pick[0].code}（${pick[0].name}）を補いました${pick[0].note ? `（${pick[0].note}）` : ''}`;
        if (pick[0].match === 'former') r._warn.push(msg + '。新しい支店名で問題ないか確認してください'); else r._info.push(msg);
        const sim = similarBranches(r.bankCode, pick[0].code);
        if (sim.length && pick[0].match === 'exact') r._info.push(`似た名前の支店もあります: ${fmt(sim)}`);
      } else if (pick.length === 1 && pick[0].match === 'partial') {
        r.branchCode = pick[0].code;
        r._warn.push(`支店名「${raw}」を ${pick[0].code}（${pick[0].name}）と推定しました。正しいか確認してください`);
      } else if (pick.length && pick[0].match === 'fuzzy') r._warn.push(`支店名「${raw}」が見つかりません。もしかして: ${fmt(pick)}`);
      else if (pick.length > 1) r._warn.push(`支店名「${raw}」に候補が複数あります: ${fmt(pick)}`);
      else {
        // いまの一覧に無い名前。消えた支店の名前なら、そのことを伝える
        const gone = [];
        for (const [code, evs] of Object.entries(hist)) for (const e of evs) if (e.t === 'removed' && normName(stripBranch(e.name)) === keysOf(raw, stripBranch).n) gone.push({ code, name: e.name, d: e.d });
        if (gone.length) r._warn.push(`支店名「${raw}」は ${ym(gone[0].d)}に支店一覧から外れた支店です（旧コード ${gone[0].code}）。統廃合の可能性があるので、受取人に新しい支店を確認してください`);
        else r._warn.push(`支店名「${raw}」がこの銀行の支店一覧に見つかりません`);
      }
    }
    return rows;
  }

  return {
    load, bank, branches, branch, branchHistory, mergedInfo, findBank, findBranch, similarBranches, resolveRows,
    normName, romajiToKana, setLoader,
    setBase(b) { base = b; },
    get version() { return cache.version; }, get loaded() { return !!cache.banks; },
  };
});
