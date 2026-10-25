/* Local comparison only. No storage, network, or payment operations. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransferCompare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const text = v => String(v == null ? '' : v).trim();
  const digits = (v, width) => {
    const s = text(v).normalize('NFKC');
    if (!/^\d+$/.test(s) || s.length > width) throw new Error('コード・口座番号は指定桁数内の数字で入力してください');
    return s.padStart(width, '0');
  };
  function normalize(raw) {
    const inputAmount = text(raw.amount).normalize('NFKC');
    const amount = inputAmount.replace(/,/g, '');
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(inputAmount) || !Number.isSafeInteger(Number(amount))) throw new Error('金額は0以上の整数（円）で入力してください');
    const name = text(raw.name).normalize('NFKC');
    if (!name) throw new Error('名義がありません');
    const depositType = text(raw.depositType).normalize('NFKC');
    if (!['1', '2', '4'].includes(depositType)) throw new Error('預金種目は1・2・4を指定してください');
    return { id: text(raw.id), name, amount: Number(amount), bankCode: digits(raw.bankCode, 4), branchCode: digits(raw.branchCode, 3), depositType, accountNo: digits(raw.accountNo, 7) };
  }
  const account = r => [r.bankCode, r.branchCode, r.depositType, r.accountNo].join('/');
  const group = (rs, key) => {
    const out = new Map();
    rs.forEach((r, i) => { const k = key(r); if (k) out.set(k, [...(out.get(k) || []), i]); });
    return out;
  };
  function compare(before, after, useId) {
    const usedB = new Set(), usedA = new Set(), matches = [], ambiguous = [];
    const bg = group(before, r => useId ? r.id : account(r)), ag = group(after, r => useId ? r.id : account(r));
    for (const key of new Set([...bg.keys(), ...ag.keys()])) {
      const bs = bg.get(key) || [], as = ag.get(key) || [];
      if (bs.length > 1 || as.length > 1) {
        ambiguous.push({ reason: useId ? '識別子が重複' : '同一口座が複数行', before: bs, after: as });
      } else if (bs.length === 1 && as.length === 1) {
        const b = before[bs[0]], a = after[as[0]];
        usedB.add(bs[0]); usedA.add(as[0]);
        matches.push({ before: b, after: a, basis: useId ? '利用者が指定した識別子' : '同一口座（同一人物とは未確認）', accountChanged: account(b) !== account(a), nameChanged: b.name !== a.name, delta: a.amount - b.amount });
      }
    }
    const removed = before.filter((_, i) => !usedB.has(i)), added = after.filter((_, i) => !usedA.has(i));
    // A matching name is only a candidate. Never deduct it from added/removed or assign a monetary delta.
    const namesB = group(before.map((r, i) => usedB.has(i) ? { ...r, name: '' } : r), r => r.name);
    const namesA = group(after.map((r, i) => usedA.has(i) ? { ...r, name: '' } : r), r => r.name);
    for (const [name, bs] of namesB) {
      const as = namesA.get(name);
      if (as && (bs.length > 1 || as.length > 1 || account(before[bs[0]]) !== account(after[as[0]]))) ambiguous.push({ reason: '同名の口座変更候補・同一人物とは未確認', before: bs, after: as });
    }
    if (useId && [...before, ...after].some(r => !r.id)) ambiguous.push({ reason: '識別子が空の行は照合しません', before: [], after: [] });
    const sum = rs => { const n = rs.reduce((s, r) => s + r.amount, 0); if (!Number.isSafeInteger(n)) throw new Error('合計金額が安全に計算できる範囲を超えています'); return n; };
    const beforeTotal = sum(before), afterTotal = sum(after);
    return { matches, removed, added, ambiguous, beforeTotal, afterTotal, totalDelta: afterTotal - beforeTotal };
  }
  return { normalize, compare, account };
});
