/* pricing.js — 料金ページの月払い／年払い切替 */
(function () {
  var btns = document.querySelectorAll('.billing button');
  var price = document.querySelector('.plan.hot .price');
  var unit = document.getElementById('unit');
  var note = document.getElementById('cycleNote');
  if (!btns.length || !price) return;
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      btns.forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      var y = b.dataset.cycle === 'year';
      price.childNodes[0].nodeValue = y ? price.dataset.year : price.dataset.month;
      unit.textContent = y ? '/年' : '/月';
      note.textContent = y ? '年払い（月あたり400円）。期間末まで利用可' : '月払い。いつでも解約可';
    });
  });
})();
