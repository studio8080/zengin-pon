/* GA4: public page views only. Never read tool inputs, files or licenses. */
(function () {
  'use strict';
  var id = 'G-13WS8YJMBV';
  var optKey = 'zenginponAnalyticsOptOut';
  var button = document.getElementById('analytics-optout');
  var status = document.getElementById('analytics-optout-status');
  var optedOut = false;
  try { optedOut = localStorage.getItem(optKey) === '1'; } catch (_) {}
  if (status && optedOut) status.textContent = 'アクセス解析は無効です。';
  if (button) button.addEventListener('click', function () {
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
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
  document.head.appendChild(script);
})();
