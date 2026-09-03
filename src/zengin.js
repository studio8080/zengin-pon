/*
 * zengin.js — 全銀協フォーマット（固定長120バイト）生成エンジン
 *
 * 依存なし。ブラウザ（window.Zengin）でも Node（module.exports）でも動く。
 * 対応: 総合振込(種別21) / 給与振込(11) / 賞与振込(12)
 *
 * 文字コード: JIS X 0201（いわゆる Shift_JIS の1バイト部分のみ）。
 * 全銀フォーマットで許される文字は 数字・英大文字・半角カナ・記号 ()-./¥｢｣ と空白 だけなので、
 * 1文字=1バイトで完結し、外部のエンコーディングライブラリは要らない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Zengin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------
  // 1. 文字の正規化（全角→半角カナ、ひらがな→カナ、法人略語 など）
  // ------------------------------------------------------------

  const FW_KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョーヰヱヮ';
  const HW_KANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｯｬｭｮｰｲｴﾜ';
  const DAKU = {
    'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ',
    'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
    'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ',
    'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
    'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ',
    'ヴ': 'ｳﾞ', 'ヷ': 'ﾜﾞ', 'ヺ': 'ｦﾞ',
  };
  const KANA_TABLE = {};
  for (let i = 0; i < FW_KANA.length; i++) KANA_TABLE[FW_KANA[i]] = HW_KANA[i];
  Object.assign(KANA_TABLE, DAKU);

  // 単独の濁点・半濁点（結合文字含む）
  KANA_TABLE['゛'] = 'ﾞ'; KANA_TABLE['゜'] = 'ﾟ';
  KANA_TABLE['゙'] = 'ﾞ'; KANA_TABLE['゚'] = 'ﾟ';

  // 記号類
  const SYMBOL_TABLE = {
    '　': ' ',            // 全角空白
    '－': '-', '‐': '-', '−': '-', '―': '-', '—': '-', '–': '-',
    '／': '/', '．': '.', '（': '(', '）': ')', '「': '｢', '」': '｣',
    '￥': '¥', '\\': '¥',      // バックスラッシュは JIS X 0201 では円記号
    '・': '.', '･': '.',       // 中点は使えないので「.」に置換（銀行慣行）
    '，': ',', '、': ',', '。': '.', '｡': '.', '､': ',',
  };

  // 小書きカナ → 大文字（多くの銀行が「拗音・促音は大文字」を求める）
  const SMALL_TO_LARGE = { 'ｧ': 'ｱ', 'ｨ': 'ｲ', 'ｩ': 'ｳ', 'ｪ': 'ｴ', 'ｫ': 'ｵ', 'ｯ': 'ﾂ', 'ｬ': 'ﾔ', 'ｭ': 'ﾕ', 'ｮ': 'ﾖ' };

  // 法人種別の略語（全銀協「振込依頼書等記載要領」準拠）。長いものから先にマッチさせる。
  const CORP_ABBR = [
    ['特定非営利活動法人', 'ﾄｸﾋ'], ['社会保険労務士法人', 'ﾛｳﾑ'], ['有限責任事業組合', 'ﾕｳｸﾐ'],
    ['地方独立行政法人', 'ﾁﾄﾞｸ'], ['独立行政法人', 'ﾄﾞｸ'], ['社会福祉法人', 'ﾌｸ'], ['更生保護法人', 'ﾎｺﾞ'],
    ['国立大学法人', 'ﾀﾞｲ'], ['公立大学法人', 'ﾀﾞｲ'], ['一般財団法人', 'ｻﾞｲ'], ['公益財団法人', 'ｻﾞｲ'],
    ['一般社団法人', 'ｼｬ'], ['公益社団法人', 'ｼｬ'], ['医療法人社団', 'ｲ'], ['医療法人財団', 'ｲ'],
    ['社会医療法人', 'ｲ'], ['農事組合法人', 'ﾉｳ'], ['行政書士法人', 'ｷﾞｮ'], ['司法書士法人', 'ｼﾎｳ'],
    ['有限責任中間法人', 'ﾁｭｳ'], ['無限責任中間法人', 'ﾁｭｳ'], ['土地改良区', 'ﾄﾁ'],
    ['株式会社', 'ｶ'], ['有限会社', 'ﾕ'], ['合名会社', 'ﾒ'], ['合資会社', 'ｼ'], ['合同会社', 'ﾄﾞ'],
    ['医療法人', 'ｲ'], ['財団法人', 'ｻﾞｲ'], ['社団法人', 'ｼｬ'], ['宗教法人', 'ｼｭｳ'], ['学校法人', 'ｶﾞｸ'],
    ['相互会社', 'ｿ'], ['弁護士法人', 'ﾍﾞﾝ'], ['税理士法人', 'ｾﾞｲ'], ['監査法人', 'ｶﾝ'], ['特許業務法人', 'ﾄｯｷｮ'],
    ['生活協同組合', 'ｾｲｷｮｳ'], ['協同組合', 'ｷｮｳｸﾐ'], ['管理組合', 'ｶﾝﾘ'], ['連合会', 'ﾚﾝ'], ['共済組合', 'ｷｮｳｻｲ'],
  ];
  // 営業所等（末尾のみ）
  const UNIT_ABBR = [['営業所', 'ｴｲ'], ['出張所', 'ｼｭﾂ']];

  /**
   * 法人種別を略語に置換する。
   * 先頭 → 「ｶ)」、末尾 → 「(ｶ」、中間 → 「(ｶ)」
   */
  function abbreviateCorp(name) {
    let s = String(name || '').trim();
    for (const [word, abbr] of CORP_ABBR) {
      if (s.startsWith(word)) s = abbr + ')' + s.slice(word.length);
      else if (s.endsWith(word)) s = s.slice(0, -word.length) + '(' + abbr;
      else if (s.includes(word)) s = s.replace(word, '(' + abbr + ')');
    }
    for (const [word, abbr] of UNIT_ABBR) {
      if (s.endsWith(word)) s = s.slice(0, -word.length) + '(' + abbr;
    }
    return s;
  }

  /**
   * 任意の文字列を 全銀で使える文字（半角カナ・英大文字・数字・記号）に寄せる。
   * 変換できない文字（漢字など）はそのまま残す → 後で validate() が拾う。
   */
  function toZenginChars(input, opts) {
    opts = opts || {};
    let s = String(input == null ? '' : input);
    s = s.normalize('NFC');
    if (opts.abbreviateCorp !== false) s = abbreviateCorp(s);
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      let c = ch;
      if (cp >= 0x3041 && cp <= 0x3096) c = String.fromCodePoint(cp + 0x60); // ひらがな→カタカナ
      if (KANA_TABLE[c] != null) { out += KANA_TABLE[c]; continue; }
      if (SYMBOL_TABLE[c] != null) { out += SYMBOL_TABLE[c]; continue; }
      const cp2 = c.codePointAt(0);
      if (cp2 >= 0xFF01 && cp2 <= 0xFF5E) { out += String.fromCodePoint(cp2 - 0xFEE0); continue; } // 全角英数記号
      out += c;
    }
    out = out.toUpperCase();
    if (opts.smallToLarge !== false) out = out.replace(/[ｧｨｩｪｫｯｬｭｮ]/g, (m) => SMALL_TO_LARGE[m]);
    out = out.replace(/\s+/g, ' ').trim();
    return out;
  }

  // 全銀で使える文字（JIS X 0201 のうち銀行が受け付ける範囲）
  const ALLOWED_RE = /^[0-9A-Z ()\-./¥｢｣ｦ-ﾟ]*$/;

  function invalidChars(s) {
    const bad = [];
    for (const ch of String(s)) if (!ALLOWED_RE.test(ch)) bad.push(ch);
    return [...new Set(bad)];
  }

  // ------------------------------------------------------------
  // 2. フィールド整形
  // ------------------------------------------------------------

  function C(str, len) { // 文字項目: 左詰め・空白埋め・超過は切り捨て
    const s = String(str == null ? '' : str);
    return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
  }
  function N(val, len) { // 数字項目: 右詰め・0埋め
    const s = String(val == null ? '' : val).replace(/[^0-9]/g, '');
    if (s.length > len) throw new Error(`数値が桁数(${len})を超えています: ${s}`);
    return '0'.repeat(len - s.length) + s;
  }
  function digits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

  function parseAmount(v) {
    if (typeof v === 'number') return Math.round(v);
    const s = String(v == null ? '' : v).replace(/[,，¥￥\s円]/g, '').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
    if (s === '') return NaN;
    return Math.round(Number(s));
  }

  /** 預金種目: 普通=1 当座=2 貯蓄=4 その他=9 */
  function parseDepositType(v) {
    const s = String(v == null ? '' : v).trim();
    if (/^[1249]$/.test(s)) return s;
    if (/普|ﾌﾂｳ|フツウ|ordinary|saving/i.test(s)) return '1';
    if (/当|ﾄｳｻﾞ|トウザ|current|checking/i.test(s)) return '2';
    if (/貯蓄|ﾁｮﾁｸ|チョチク/i.test(s)) return '4';
    if (s === '') return '1';
    return '9';
  }

  /**
   * ゆうちょ銀行の 記号・番号 → 全銀の 店番・口座番号 変換
   *   総合口座(記号 1xxx0): 店番 = 記号の2〜3桁目 + '8', 預金種目=普通, 口座番号 = 番号の末尾1を除いた7桁
   *   振替口座(記号 0xxxx): 店番 = 記号の2〜3桁目 + '9', 預金種目=当座, 口座番号 = 番号を7桁0埋め
   */
  function yuchoToZengin(kigo, bango) {
    const k = digits(kigo), b = digits(bango);
    if (k.length !== 5) throw new Error(`ゆうちょ記号は5桁です: ${kigo}`);
    const mid = k.slice(1, 3);
    if (k[0] === '1') {
      const acct = (b.length === 8 && b.endsWith('1')) ? b.slice(0, 7) : b.padStart(7, '0').slice(-7);
      return { bankCode: '9900', branchCode: mid + '8', depositType: '1', accountNo: acct };
    }
    if (k[0] === '0') {
      return { bankCode: '9900', branchCode: mid + '9', depositType: '2', accountNo: b.padStart(7, '0').slice(-7) };
    }
    throw new Error(`ゆうちょ記号の形式が不明です: ${kigo}`);
  }

  // ------------------------------------------------------------
  // 3. レコード生成
  // ------------------------------------------------------------

  const KIND = { SOGO: '21', KYUYO: '11', SHOYO: '12' };
  const KIND_LABEL = { '21': '総合振込', '11': '給与振込', '12': '賞与振込' };

  /**
   * header = {
   *   kind: '21'|'11'|'12', clientCode: '0000000000', clientName: 'ｶ)ｺｺｷｶｸ',
   *   date: 'MMDD', bankCode:'0005', bankName:'', branchCode:'001', branchName:'',
   *   depositType:'1', accountNo:'1234567'
   * }
   */
  function headerRecord(h) {
    return '1' + N(h.kind, 2) + '0' + N(h.clientCode, 10) + C(h.clientName, 40) + N(h.date, 4)
      + N(h.bankCode, 4) + C(h.bankName, 15) + N(h.branchCode, 3) + C(h.branchName, 15)
      + N(h.depositType, 1) + N(h.accountNo, 7) + C('', 17);
  }

  /**
   * row = {
   *   bankCode, bankName, branchCode, branchName, depositType, accountNo, name, amount,
   *   newCode('0'|'1'|'2'), customerCode1, customerCode2 (総合) / employeeNo, deptCode (給与),
   *   transferType('7'電信|'8'文書 総合のみ), ediFlag('Y'|'' 総合のみ)
   * }
   */
  function dataRecord(row, kind) {
    const common = '2' + N(row.bankCode, 4) + C(row.bankName, 15) + N(row.branchCode, 3) + C(row.branchName, 15)
      + C('', 4) /* 手形交換所番号(未使用) */ + N(row.depositType, 1) + N(row.accountNo, 7)
      + C(row.name, 30) + N(row.amount, 10) + N(row.newCode || '0', 1);
    if (kind === KIND.SOGO) {
      return common + N(row.customerCode1 || '', 10) + N(row.customerCode2 || '', 10)
        + N(row.transferType || '7', 1) + C(row.ediFlag || '', 1) + C('', 7);
    }
    // 給与・賞与
    return common + N(row.employeeNo || '', 10) + N(row.deptCode || '', 10) + C('', 9);
  }

  function trailerRecord(count, total) {
    return '8' + N(count, 6) + N(total, 12) + C('', 101);
  }
  function endRecord() { return '9' + C('', 119); }

  /**
   * 全レコードを組み立てる。
   * @returns { records: string[], count, total, text }
   */
  function build(header, rows, opts) {
    opts = opts || {};
    const kind = header.kind;
    const records = [headerRecord(header)];
    let total = 0;
    for (const r of rows) { records.push(dataRecord(r, kind)); total += Number(r.amount); }
    records.push(trailerRecord(rows.length, total));
    records.push(endRecord());
    for (const rec of records) {
      if (rec.length !== 120) throw new Error(`内部エラー: レコード長が120ではありません(${rec.length}): ${rec}`);
    }
    const nl = opts.newline === 'none' ? '' : opts.newline === 'LF' ? '\n' : '\r\n';
    return { records, count: rows.length, total, text: records.map((r) => r + nl).join('') };
  }

  // ------------------------------------------------------------
  // 4. 検証
  // ------------------------------------------------------------

  function validateHeader(h) {
    const errs = [];
    if (!KIND_LABEL[h.kind]) errs.push('種別コードが不正です');
    if (!/^\d{1,10}$/.test(digits(h.clientCode))) errs.push('振込依頼人コードは10桁以内の数字');
    const nm = toZenginChars(h.clientName);
    if (!nm) errs.push('振込依頼人名が空です');
    const bad = invalidChars(nm);
    if (bad.length) errs.push(`振込依頼人名に使えない文字: ${bad.join(' ')}`);
    if (nm.length > 40) errs.push('振込依頼人名が40文字を超えています');
    if (!/^\d{4}$/.test(digits(h.date))) errs.push('振込日はMMDD 4桁');
    if (!/^\d{4}$/.test(digits(h.bankCode))) errs.push('仕向銀行コードは4桁');
    if (!/^\d{3}$/.test(digits(h.branchCode))) errs.push('仕向支店コードは3桁');
    if (!/^\d{1,7}$/.test(digits(h.accountNo))) errs.push('仕向口座番号は7桁以内');
    return errs;
  }

  function validateRow(r, kind) {
    const errs = [];
    if (r._yuchoError) errs.push(r._yuchoError);
    if (!/^\d{4}$/.test(digits(r.bankCode))) errs.push('銀行コード4桁');
    if (!/^\d{3}$/.test(digits(r.branchCode))) errs.push('支店コード3桁');
    if (!/^\d{1,7}$/.test(digits(r.accountNo))) errs.push('口座番号1〜7桁');
    if (!/^[1249]$/.test(String(r.depositType))) errs.push('預金種目');
    if (kind !== KIND.SOGO && !/^[12]$/.test(String(r.depositType))) errs.push('給与振込は普通/当座のみ');
    if (!r.name) errs.push('受取人名が空');
    else {
      const bad = invalidChars(r.name);
      if (bad.length) errs.push(`使えない文字: ${bad.join(' ')}`);
      if (r.name.length > 30) errs.push('受取人名30文字超');
    }
    const amt = Number(r.amount);
    if (!Number.isInteger(amt) || amt <= 0) errs.push('金額は1以上の整数');
    else if (amt > 9999999999) errs.push('金額が10桁超');
    for (const [k, len] of [['bankName', 15], ['branchName', 15]]) {
      if (r[k]) {
        const bad = invalidChars(r[k]);
        if (bad.length) errs.push(`${k === 'bankName' ? '銀行名' : '支店名'}に使えない文字: ${bad.join(' ')}`);
        if (r[k].length > len) errs.push(`${k === 'bankName' ? '銀行名' : '支店名'}${len}文字超`);
      }
    }
    return errs;
  }

  // ------------------------------------------------------------
  // 5. エンコード（JIS X 0201）
  // ------------------------------------------------------------

  function encode(text) {
    const bytes = new Uint8Array(text.length);
    let n = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      let b;
      if (cp === 0xA5 || cp === 0xFFE5) b = 0x5C;           // ¥
      else if (cp >= 0xFF61 && cp <= 0xFF9F) b = 0xA1 + (cp - 0xFF61); // 半角カナ
      else if (cp < 0x80) b = cp;
      else throw new Error(`エンコードできない文字: ${ch} (U+${cp.toString(16).toUpperCase()})`);
      bytes[n++] = b;
    }
    return bytes.subarray(0, n);
  }

  /** バイト列 → 文字列（確認・テスト用の逆変換） */
  function decode(bytes) {
    let s = '';
    for (const b of bytes) {
      if (b >= 0xA1 && b <= 0xDF) s += String.fromCodePoint(0xFF61 + (b - 0xA1));
      else if (b === 0x5C) s += '¥';
      else s += String.fromCharCode(b);
    }
    return s;
  }

  // ------------------------------------------------------------
  // 6. 行の正規化（生の入力オブジェクト → レコード用オブジェクト）
  // ------------------------------------------------------------

  /**
   * raw = { bankCode, bankName, branchCode, branchName, depositType, accountNo, name, amount,
   *         customerCode1, customerCode2, employeeNo, deptCode, transferType, ediFlag, yuchoKigo, yuchoBango }
   */
  /**
   * 銀行名・支店名は任意項目（銀行側はコードで判定する）。
   * 「銀行」「支店」などの接尾語を落としてカナ化し、それでも漢字が残るなら空欄にする。
   */
  function optionalName(v, opts) {
    let s = String(v == null ? '' : v).trim()
      .replace(/(銀行|信用金庫|信用組合|信金|労働金庫|農業協同組合|農協|支店|本店営業部|営業部|出張所)$/u, '');
    if (/^本店$/u.test(String(v || '').trim())) s = 'ホンテン';
    const out = toZenginChars(s, { abbreviateCorp: false, smallToLarge: opts.smallToLarge });
    return invalidChars(out).length ? '' : out;
  }

  function normalizeRow(raw, opts) {
    opts = opts || {};
    const bc = digits(raw.bankCode), brc = digits(raw.branchCode);
    const r = {
      bankCode: bc ? bc.padStart(4, '0').slice(-4) : '',
      bankName: optionalName(raw.bankName, opts),
      branchCode: brc ? brc.padStart(3, '0').slice(-3) : '',
      branchName: optionalName(raw.branchName, opts),
      depositType: parseDepositType(raw.depositType),
      accountNo: digits(raw.accountNo),
      name: toZenginChars(raw.name, opts),
      amount: parseAmount(raw.amount),
      newCode: /^[012]$/.test(String(raw.newCode || '').trim()) ? String(raw.newCode).trim() : '0',
      customerCode1: digits(raw.customerCode1), customerCode2: digits(raw.customerCode2),
      employeeNo: digits(raw.employeeNo), deptCode: digits(raw.deptCode),
      transferType: /^[78]$/.test(String(raw.transferType || '').trim()) ? String(raw.transferType).trim() : (opts.defaultTransferType || '7'),
      ediFlag: /^y$/i.test(String(raw.ediFlag || '').trim()) ? 'Y' : '',
    };
    // ゆうちょ 記号・番号 が指定されていればそちらを優先
    const kigo = digits(raw.yuchoKigo), bango = digits(raw.yuchoBango);
    if (kigo && bango) {
      try { Object.assign(r, yuchoToZengin(kigo, bango)); } catch (e) { r._yuchoError = e.message; }
    }
    return r;
  }

  return {
    KIND, KIND_LABEL,
    abbreviateCorp, toZenginChars, invalidChars, parseAmount, parseDepositType, yuchoToZengin,
    headerRecord, dataRecord, trailerRecord, endRecord, build,
    validateHeader, validateRow, normalizeRow, encode, decode,
  };
});
