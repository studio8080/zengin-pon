/* pricing.js — 料金ページの月払い／年払い切替と、Stripe 支払いリンクの差し込み */
(function () {
  var cfg = window.ZENGIN_CONFIG || {};
  var btns = [].slice.call(document.querySelectorAll('.billing button'));
  var price = document.querySelector('.plan.hot .price');
  var unit = document.getElementById('unit');
  var note = document.getElementById('cycleNote');
  var cta = document.getElementById('proCta');
  if (!btns.length || !price) return;

  function apply(cycle) {
    var y = cycle === 'year';
    price.childNodes[0].nodeValue = y ? price.dataset.year : price.dataset.month;
    unit.textContent = y ? '/年' : '/月';
    note.textContent = y ? '年払い（月あたり400円）。期間末まで利用可' : '月払い。いつでも解約可';
    if (!cta) return;
    var link = y ? cfg.STRIPE_LINK_YEAR : cfg.STRIPE_LINK_MONTH;
    if (link) {
      cta.href = link;
      cta.textContent = y ? 'Proを申し込む（年払い ¥4,800）' : 'Proを申し込む（月払い ¥480）';
      cta.classList.remove('is-disabled');
      cta.removeAttribute('aria-disabled');
      cta.setAttribute('rel', 'noopener');
    } else {
      cta.href = '#buy';
      cta.textContent = 'Proを申し込む（準備中）';
      cta.classList.add('is-disabled');
      cta.setAttribute('aria-disabled', 'true');
    }
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      btns.forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      apply(b.dataset.cycle);
    });
  });
  apply('month');
})();
