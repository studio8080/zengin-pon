/* site.js — 共通ヘッダー／フッターの差し込み（静的サイトで全ページ同じにするため）＋アクセス解析 */
(function () {
  'use strict';

  // ---- Google アナリティクス（config.js に測定IDがあるときだけ読み込む） ----
  // 変換対象のデータは一切送らない。ページの閲覧しか計測しない。
  const gaId = (window.ZENGIN_CONFIG || {}).GA_MEASUREMENT_ID;
  if (gaId) {
    const s = document.createElement('script');
    s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gaId);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', gaId, { anonymize_ip: true });
  }

  const depth = (document.body.dataset.depth || '') === '1' ? '../' : '';
  const path = location.pathname.replace(/\/index\.html$/, '/');
  const links = [
    ['index.html#tool', '変換ツール'], ['guide.html', '使い方'], ['pricing.html', '料金'], ['security.html', 'セキュリティ'],
    ['faq.html', 'よくある質問'], ['banks/', '銀行コード検索'],
  ];
  const isCurrent = (href) => {
    const h = href.replace(/#.*$/, '');
    if (h === 'index.html') return /\/$|index\.html$/.test(path) && !depth;
    return path.endsWith('/' + h) || (h.endsWith('/') && path.endsWith(h));
  };
  const logo = `<svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="6" width="32" height="28" rx="6" fill="#14305c"/><path d="M11 15h18M11 20h18M11 25h11" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="29" cy="27" r="6" fill="#ff7a1a"/><path d="M26.5 27l1.8 1.8L32 25.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`;
  const header = document.createElement('header');
  header.className = 'site-head';
  header.innerHTML = `<div class="wrap in">
    <a class="brand" href="${depth}index.html">${logo}<span><b>全銀ポン</b><small>全銀フォーマット変換ツール</small></span></a>
    <button class="nav-toggle" aria-label="メニュー" aria-expanded="false">☰</button>
    <nav class="nav" aria-label="サイト内">
      ${links.map(([h, t]) => `<a href="${depth}${h}" class="${isCurrent(h) ? 'is-current' : ''}">${t}</a>`).join('')}
      <a class="cta" href="${depth}index.html#tool">無料で試す</a>
    </nav></div>`;
  document.body.prepend(header);
  header.querySelector('.nav-toggle').addEventListener('click', (e) => {
    const nav = header.querySelector('.nav');
    nav.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', nav.classList.contains('open'));
  });

  const footer = document.createElement('footer');
  footer.className = 'site-foot';
  footer.innerHTML = `<div class="wrap in">
    <div><h4>全銀ポン</h4><p style="margin:0;color:var(--muted)">給与振込・総合振込のExcel／CSV／PDF／Googleスプレッドシートを、ネットバンキングに取り込める全銀フォーマットへ。データはブラウザの中だけで処理します。</p></div>
    <div><h4>サービス</h4><a href="${depth}index.html#tool">変換ツール</a><a href="${depth}guide.html">使い方</a><a href="${depth}pricing.html">料金プラン</a><a href="${depth}banks/">銀行コード・支店コード検索</a></div>
    <div><h4>安心・サポート</h4><a href="${depth}security.html">セキュリティとデータの扱い</a><a href="${depth}faq.html">よくある質問</a><a href="${depth}guide.html#banks">銀行別の取込方法</a><a href="${depth}guide.html#notes">ご利用上の注意</a></div>
    <div><h4>規約など</h4><a href="${depth}terms.html">利用規約</a><a href="${depth}privacy.html">プライバシーポリシー</a><a href="${depth}tokushoho.html">特定商取引法に基づく表記</a><a href="https://kokokikaku.com/" target="_blank" rel="noopener">運営会社</a></div>
  </div><div class="wrap copy">© ここ企画 — 本サービスは振込データの作成のみを行い、送金は行いません。振込内容の最終確認はご自身のネットバンキングで行ってください。</div>`;
  document.body.append(footer);
})();
