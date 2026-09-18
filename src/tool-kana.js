/* tool-kana.js — 口座名義を振込用の半角カナに変換（/free-tools/kana.html）
 * 変換は Zengin.toZenginChars（変換ツール本体と同じもの）。入力は保存も送信もしない。 */
(function () {
  'use strict';
  var Z = window.Zengin;
  var input = document.getElementById('kanaIn'), small = document.getElementById('kanaSmall'), out = document.getElementById('kanaResult');
  if (!Z || !input || !out) return;
  var LIMIT = 30;

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render() {
    var lines = input.value.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 200);
    if (!lines.length) { out.innerHTML = '<p class="hint">名義を入れると、ここに結果が出ます。</p>'; return; }
    var html = '<div class="tablewrap"><table><thead><tr><th>入力</th><th>振込用の名義</th><th>文字数</th><th>確認</th></tr></thead><tbody>';
    lines.forEach(function (line) {
      var conv = Z.toZenginChars(line, { smallToLarge: small.checked });
      var bad = Z.invalidChars(conv);
      var len = Array.from(conv).length;
      var notes = [];
      if (bad.length) notes.push('<span class="msg ng">使えない文字: ' + esc(bad.join(' ')) + '（カナで入れ直してください）</span>');
      if (len > LIMIT) notes.push('<span class="msg warn">受取人名の上限 ' + LIMIT + ' 文字を ' + (len - LIMIT) + ' 文字超えています</span>');
      if (!notes.length) notes.push('<span class="tag ok">OK</span>');
      var shown = Array.from(conv).map(function (ch) { return bad.indexOf(ch) >= 0 ? '<mark class="badch">' + esc(ch) + '</mark>' : esc(ch); }).join('');
      html += '<tr class="' + (bad.length ? 'bad' : len > LIMIT ? 'warn' : '') + '"><td>' + esc(line) + '</td><td class="mono">' + shown + '</td><td class="r">' + len + '</td><td>' + notes.join('') + '</td></tr>';
    });
    out.innerHTML = html + '</tbody></table></div>';
  }
  input.addEventListener('input', render);
  small.addEventListener('change', render);
})();
