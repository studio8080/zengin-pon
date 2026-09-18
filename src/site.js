/* site.js — 全ページ共通の小さな動き（メニューの開閉）と、アクセス解析の読み込み。
 * ヘッダーとフッターそのものは HTML に直接書いてある（tools/build-site.js が埋め込む）。
 * JavaScript を実行しないクローラーや読み上げソフトにも同じ内容が見えるようにするため。 */
(function () {
  'use strict';

  // ---- Google アナリティクス（config.js に測定IDがあるときだけ読み込む） ----
  // 変換対象のデータは一切送らない。ページの閲覧しか計測しない。
  var gaId = (window.ZENGIN_CONFIG || {}).GA_MEASUREMENT_ID;
  if (gaId) {
    var s = document.createElement('script');
    s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', gaId, { anonymize_ip: true });
  }

  // ---- スマホ用メニューの開閉 ----
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
    });
  }
})();
