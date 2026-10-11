/* GA4: public pages and explicitly labelled public links only.
 * Never read tool inputs, files, link URLs or licenses. */
(function () {
  'use strict';
  if (window.__zenginponAnalytics) return;
  window.__zenginponAnalytics = true;
  var id = 'G-13WS8YJMBV';
  var optKey = 'zenginponAnalyticsOptOut';
  var button = document.getElementById('analytics-optout');
  var status = document.getElementById('analytics-optout-status');
  var optedOut = false;
  try { optedOut = localStorage.getItem(optKey) === '1'; } catch (_) { optedOut = true; }
  if (status && optedOut) status.textContent = 'アクセス解析は無効です。';
  if (button) button.addEventListener('click', function () {
    optedOut = true;
    try { localStorage.setItem(optKey, '1'); } catch (_) {}
    window['ga-disable-' + id] = true;
    document.cookie.split(';').forEach(function (entry) {
      var name = entry.trim().split('=')[0];
      if (!/^_ga(?:_|$)/.test(name)) return;
      ['', '; domain=' + location.hostname, '; domain=.' + location.hostname + ''].forEach(function (domain) {
        document.cookie = name + '=; Max-Age=0; path=/' + domain + '; SameSite=Lax';
      });
    });
    if (status) status.textContent = 'アクセス解析を無効にしました。';
  });
  if (optedOut || navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  // Referrers can contain personal data; send only the origin.
  var referrer = '';
  try { referrer = new URL(document.referrer).origin + '/'; } catch (_) {}
  var page = location.origin + location.pathname;
  var settings = { send_page_view: false, page_location: page, page_referrer: referrer,
    page_title: document.title, allow_google_signals: false, allow_ad_personalization_signals: false,
    cookie_domain: location.hostname };
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  gtag('consent', 'default', { analytics_storage: 'denied',
    region: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH'] });
  gtag('js', new Date());
  gtag('config', id, settings);
  gtag('event', 'page_view', { page_location: page, page_referrer: referrer, page_title: document.title });
  // These pages contain explanations and public plan choices, not transfer inputs.
  var publicPages = ['/guide.html', '/zengin-format.html', '/faq.html', '/pricing.html', '/free-tools/'];
  if (publicPages.indexOf(location.pathname) !== -1) {
    document.addEventListener('click', function (event) {
      try {
        if (optedOut || window['ga-disable-' + id] || navigator.doNotTrack === '1' ||
            window.doNotTrack === '1' || navigator.globalPrivacyControl === true ||
            localStorage.getItem(optKey) === '1') return;
        var link = event.target && event.target.closest && event.target.closest('a[data-revenue-action]');
        if (!link || link.getAttribute('aria-disabled') === 'true') return;
        var action = link.getAttribute('data-revenue-action');
        var placement = link.getAttribute('data-revenue-placement');
        if (['tool', 'pro', 'checkout'].indexOf(action) === -1 ||
            ['article-end', 'article-inline', 'pricing-card'].indexOf(placement) === -1) return;
        var params = { action: action, placement: placement, page_location: page, page_referrer: '' };
        if (action === 'checkout') {
          if (location.pathname !== '/pricing.html' || placement !== 'pricing-card') return;
          var selected = document.querySelector('.billing button.on');
          var cycle = selected && selected.getAttribute('data-cycle');
          if (cycle !== 'month' && cycle !== 'year') return;
          params.plan = cycle === 'year' ? 'yearly' : 'monthly';
        }
        gtag('event', 'revenue_action', params);
      } catch (_) { /* Measurement must never interrupt navigation. */ }
    });
  }
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
  document.head.appendChild(script);
})();
