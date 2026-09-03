/* holidays.js — 銀行休業日の判定（土日・国民の祝日・12/31〜1/3）。依存なし。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Holidays = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function nthMonday(y, m, n) { const first = new Date(y, m - 1, 1).getDay(); const d = 1 + ((8 - first) % 7) + (n - 1) * 7; return ymd(y, m, d); }
  // 春分・秋分の簡易式（2000〜2099年で有効）
  function shunbun(y) { return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }
  function shubun(y) { return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }

  function nationalHolidays(y) {
    const h = new Map();
    const add = (s, name) => h.set(s, name);
    add(ymd(y, 1, 1), '元日'); add(nthMonday(y, 1, 2), '成人の日'); add(ymd(y, 2, 11), '建国記念の日'); add(ymd(y, 2, 23), '天皇誕生日');
    add(ymd(y, 3, shunbun(y)), '春分の日'); add(ymd(y, 4, 29), '昭和の日'); add(ymd(y, 5, 3), '憲法記念日'); add(ymd(y, 5, 4), 'みどりの日'); add(ymd(y, 5, 5), 'こどもの日');
    add(nthMonday(y, 7, 3), '海の日'); add(ymd(y, 8, 11), '山の日'); add(nthMonday(y, 9, 3), '敬老の日'); add(ymd(y, 9, shubun(y)), '秋分の日');
    add(nthMonday(y, 10, 2), 'スポーツの日'); add(ymd(y, 11, 3), '文化の日'); add(ymd(y, 11, 23), '勤労感謝の日');
    // 振替休日: 祝日が日曜なら翌平日
    for (const [s, name] of [...h]) {
      const d = new Date(s + 'T00:00:00');
      if (d.getDay() !== 0) continue;
      let n = new Date(d); n.setDate(n.getDate() + 1);
      while (h.has(ymd(n.getFullYear(), n.getMonth() + 1, n.getDate()))) n.setDate(n.getDate() + 1);
      h.set(ymd(n.getFullYear(), n.getMonth() + 1, n.getDate()), `振替休日（${name}）`);
    }
    // 国民の休日: 祝日に挟まれた平日（敬老の日と秋分の日の間）
    const keiro = new Date(nthMonday(y, 9, 3) + 'T00:00:00'), shu = new Date(ymd(y, 9, shubun(y)) + 'T00:00:00');
    if (shu - keiro === 2 * 86400000) { const mid = new Date(keiro); mid.setDate(mid.getDate() + 1); const s = ymd(y, 9, mid.getDate()); if (!h.has(s)) h.set(s, '国民の休日'); }
    return h;
  }

  /** @param {string} s YYYY-MM-DD  @returns {string|null} 休業理由（営業日なら null） */
  function bankHolidayReason(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return null;
    const dow = d.getDay();
    if (dow === 0) return '日曜日';
    if (dow === 6) return '土曜日';
    const md = s.slice(5);
    if (md === '12-31' || md === '01-02' || md === '01-03') return '年末年始の銀行休業日';
    const name = nationalHolidays(d.getFullYear()).get(s);
    return name || null;
  }

  /** 次の営業日（当日が営業日ならその日） */
  function nextBusinessDay(s) {
    let d = new Date(s + 'T00:00:00');
    for (let i = 0; i < 15; i++) {
      const t = ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
      if (!bankHolidayReason(t)) return t;
      d.setDate(d.getDate() + 1);
    }
    return s;
  }

  return { nationalHolidays, bankHolidayReason, nextBusinessDay };
});
