/* tool-yucho.js — ゆうちょ銀行の記号・番号 → 店名・店番・預金種目・口座番号（/free-tools/yucho.html）
 * 計算は Zengin.yuchoToZengin（変換ツール本体と同じもの）。入力は保存も送信もしない。 */
(function () {
  'use strict';
  var Z = window.Zengin;
  var kigo = document.getElementById('kigo'), bango = document.getElementById('bango'), out = document.getElementById('yuchoResult');
  if (!Z || !kigo || !bango || !out) return;

  var KANJI = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var branches = null; // 金融機関辞書にある店名（カナつき）。読めなければ漢数字だけ表示する
  fetch('/data/branches/9900.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { branches = j; render(); }).catch(function () {});

  function digits(s) {
    return String(s || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/[^0-9]/g, '');
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function row(label, value, note) {
    return '<div class="result-row"><span class="result-label">' + label + '</span><span class="result-value mono">' + esc(value) + '</span>' + (note ? '<span class="result-note">' + esc(note) + '</span>' : '') + '</div>';
  }

  function render() {
    var k = digits(kigo.value), b = digits(bango.value);
    if (!k && !b) { out.innerHTML = '<p class="hint">記号と番号を入れると、ここに結果が出ます。</p>'; return; }
    var problems = [];
    if (k.length !== 5) problems.push('記号は5桁です（いま ' + k.length + ' 桁）。');
    else if (k[0] !== '0' && k[0] !== '1') problems.push('記号は 0 か 1 で始まります。通帳の記号をもう一度確かめてください。');
    if (!b) problems.push('番号を入れてください。');
    else if (b.length > 8) problems.push('番号は最大8桁です（いま ' + b.length + ' 桁）。');
    if (k.length === 5 && k[0] === '1' && b && b.slice(-1) !== '1') problems.push('総合口座（記号が1で始まる）の番号は、ふつう末尾が 1 です。番号をもう一度確かめてください。');
    if (problems.length && (k.length !== 5 || !b || b.length > 8 || (k[0] !== '0' && k[0] !== '1'))) {
      out.innerHTML = '<p class="result-ng">' + problems.map(esc).join('<br>') + '</p>'; return;
    }
    var r;
    try { r = Z.yuchoToZengin(k, b); } catch (e) { out.innerHTML = '<p class="result-ng">' + esc(e.message) + '</p>'; return; }
    var kanji = r.branchCode.split('').map(function (d) { return KANJI[Number(d)]; }).join('');
    var known = branches && branches[r.branchCode];
    var html = '<div class="result-ok">'
      + row('銀行', 'ゆうちょ銀行', '金融機関コード 9900')
      + row('店名', (known ? known[0] : kanji) + '店', known ? '読み: ' + known[1] : '')
      + row('店番', r.branchCode)
      + row('預金種目', r.depositType === '1' ? '普通' : '当座', r.depositType === '1' ? '総合口座・通常貯金' : '振替口座')
      + row('口座番号', r.accountNo, '7桁')
      + '</div>';
    if (branches && !known) html += '<p class="result-warn">店番 ' + esc(r.branchCode) + ' は、金融機関一覧に見当たりません。記号の2・3桁目をもう一度確かめてください。</p>';
    if (problems.length) html += '<p class="result-warn">' + problems.map(esc).join('<br>') + '</p>';
    out.innerHTML = html;
  }
  kigo.addEventListener('input', render);
  bango.addEventListener('input', render);
})();
