/* banks.js — 銀行コード検索ページの絞り込み（一覧ページと各銀行ページの両方で使う） */
(function () {
  var q = document.getElementById('q');
  if (!q) return;
  function norm(s) {
    return String(s).toLowerCase().replace(/[\s　]/g, '')
      .replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 96); })
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); });
  }
  var items = [].slice.call(document.querySelectorAll('.banklist li'));
  if (items.length) {
    // 一覧ページ: 金融機関名・カナ・コードで絞り込み、空になった見出しは隠す
    var heads = [].slice.call(document.querySelectorAll('h2'));
    q.addEventListener('input', function () {
      var v = norm(q.value);
      items.forEach(function (li) { li.style.display = !v || norm(li.getAttribute('data-s')).indexOf(v) >= 0 ? '' : 'none'; });
      heads.forEach(function (h) {
        var ul = h.nextElementSibling; if (!ul || !ul.children) return;
        h.style.display = [].some.call(ul.children, function (li) { return li.style.display !== 'none'; }) ? '' : 'none';
      });
    });
    return;
  }
  // 各銀行ページ: 支店名・支店コードで絞り込み
  var rows = [].slice.call(document.querySelectorAll('#t tbody tr'));
  q.addEventListener('input', function () {
    var v = norm(q.value);
    rows.forEach(function (r) { r.style.display = !v || norm(r.textContent).indexOf(v) >= 0 ? '' : 'none'; });
  });
})();
