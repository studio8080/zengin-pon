/*
 * site-template.js — 全ページ共通の部品（ヘッダー・フッター・<head> の共通部・構造化データ）
 *
 * なぜ静的に埋め込むか:
 *   以前は src/site.js がブラウザ上でヘッダーとフッターを差し込んでいた。JavaScript を実行しない
 *   クローラー（多くのAIクローラーを含む）にはナビゲーションも運営者表記も見えず、
 *   1,100枚以上ある銀行コードのページから他のページへの内部リンクが無い状態だった。
 *   ここで HTML に直接書き込むことで、人にも機械にも同じものが見える。
 *
 * 使う側: tools/build-site.js（手書きページへの埋め込み）と tools/build-bank-pages.js（銀行ページの生成）
 * リンクはすべてルート相対（/guide.html）。独自ドメインの直下で配信しているため。
 */
'use strict';

const SITE = 'https://zenginpon.kokokikaku.com';
const SITE_NAME = '全銀ポン';
const ORG = {
  name: 'ここ企画',
  url: 'https://kokokikaku.com/',
  email: 'studio@kokokikaku.com',
};

const NAV = [
  ['/guide.html', '使い方'],
  ['/zengin-format.html', '全銀フォーマットとは'],
  ['/free-tools/', '無料ツール'],
  ['/pricing.html', '料金'],
  ['/security.html', '安心・安全'],
  ['/faq.html', 'よくある質問'],
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LOGO = '<svg class="logo" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><rect x="4" y="6" width="32" height="28" rx="6" fill="#14305c"/><path d="M11 15h18M11 20h18M11 25h11" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="29" cy="27" r="6" fill="#ff7a1a"/><path d="M26.5 27l1.8 1.8L32 25.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';

/** @param {string} current ルート相対のパス（例: '/guide.html'）。現在地の強調に使う */
function header(current) {
  const cur = (href) => (current === href || (href.endsWith('/') && href !== '/' && String(current).startsWith(href)));
  return `<a class="skip-link" href="#main">本文へ移動</a>
<header class="site-head">
  <div class="wrap in">
    <a class="brand" href="/">${LOGO}<span><b>${SITE_NAME}</b><small>全銀フォーマット変換ツール</small></span></a>
    <button class="nav-toggle" type="button" aria-label="メニューを開く" aria-expanded="false" aria-controls="site-nav">☰</button>
    <nav class="nav" id="site-nav" aria-label="サイト内メニュー">
      ${NAV.map(([h, t]) => `<a href="${h}"${cur(h) ? ' class="is-current" aria-current="page"' : ''}>${t}</a>`).join('\n      ')}
      <a class="cta" href="/#tool">無料で変換する</a>
    </nav>
  </div>
</header>`;
}

/**
 * ページの共有欄（MiseFits・MenuFits と同じ形）。外部のスクリプト（SDK）は使わず、各サービスの共有用 URL を開くだけ。
 * 共有するのは公開 URL（クエリ・# を除く）とページのタイトルだけ。noindex のページには出さない。
 */
function shareBox(path, title) {
  const url = SITE + path;
  const u = encodeURIComponent(url), t = encodeURIComponent(title || SITE_NAME);
  return `<section class="site-sns-share wrap" id="site-sns-share" aria-label="このページを共有" data-url="${esc(url)}" data-title="${esc(title || SITE_NAME)}">
  <span class="site-sns-share__label">このページを共有</span>
  <a href="https://twitter.com/intent/tweet?text=${t}&amp;url=${u}" target="_blank" rel="noopener noreferrer">X</a>
  <a href="https://social-plugins.line.me/lineit/share?url=${u}" target="_blank" rel="noopener noreferrer">LINE</a>
  <a href="https://www.threads.com/intent/post?url=${u}&amp;text=${t}" target="_blank" rel="noopener noreferrer">Threads</a>
  <button type="button" data-share-copy>リンクをコピー</button>
  <button type="button" data-share-native hidden>その他の共有…</button>
  <span class="site-sns-share__status" data-share-status role="status" aria-live="polite"></span>
</section>
`;
}

function footer(opts = {}) {
  return `${opts.share && opts.path ? shareBox(opts.path, opts.title) : ''}<footer class="site-foot">
  <div class="wrap in">
    <div>
      <h2 class="foot-h">${SITE_NAME}</h2>
      <p>給与振込・総合振込の Excel／CSV／PDF を、ネットバンキングに取り込める全銀フォーマットへ。データはブラウザの中だけで処理します。</p>
      <p class="made-by">企画・開発・運営：<a href="${ORG.url}" rel="noopener">${ORG.name}</a>（<a href="/about.html">運営者情報</a>）</p>
      <p class="made-by">${ORG.name}のほかの道具：<a href="https://misefits.kokokikaku.com/" rel="noopener">MiseFits（店舗レイアウト）</a>・<a href="https://menufits.kokokikaku.com/" rel="noopener">MenuFits（メニュー表）</a></p>
    </div>
    <div>
      <h2 class="foot-h">使う</h2>
      <a href="/#tool">全銀フォーマットに変換する</a>
      <a href="/guide.html">使い方・銀行別の取込方法</a>
      <a href="/pricing.html">料金プラン</a>
      <a href="/faq.html">よくある質問</a>
      <a href="/updates.html">更新情報・お知らせ</a>
    </div>
    <div>
      <h2 class="foot-h">調べる・無料ツール</h2>
      <a href="/zengin-format.html">全銀フォーマットとは（仕様の解説）</a>
      <a href="/banks/">銀行コード・支店コード検索</a>
      <a href="/free-tools/yucho.html">ゆうちょ 記号番号の変換</a>
      <a href="/free-tools/kana.html">口座名義のカナ変換・法人略語</a>
    </div>
    <div>
      <h2 class="foot-h">安心・規約</h2>
      <a href="/security.html">セキュリティとデータの扱い</a>
      <a href="/legal.html">法令上の位置づけ</a>
      <a href="/terms.html">利用規約</a>
      <a href="/privacy.html">プライバシーポリシー</a>
      <a href="/tokushoho.html">特定商取引法に基づく表記</a>
      <a href="/accessibility.html">アクセシビリティ</a>
      <a href="/about.html">運営者情報・お問い合わせ</a>
    </div>
  </div>
  <div class="wrap copy">© ${ORG.name} — 本サービスは振込データ（ファイル）の作成のみを行い、送金は行いません。振込内容の最終確認はご自身のネットバンキングで行ってください。</div>
</footer>`;
}

/**
 * <head> の共通部（アイコン・OGP・Twitterカード・参照元ポリシー）。
 * title と description と canonical は各ページに手書きで残す（ページごとに考えて書くものなので）。
 */
function headCommon({ title, description, path, type, noindex }) {
  const url = SITE + path;
  const lines = [
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    '<meta name="theme-color" content="#14305c">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    '<meta name="format-detection" content="telephone=no">',
    '<script defer src="/analytics.js"></script>',
  ];
  if (!noindex) {
    lines.push(
      `<meta property="og:site_name" content="${SITE_NAME}">`,
      `<meta property="og:type" content="${type || 'article'}">`,
      `<meta property="og:locale" content="ja_JP">`,
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      `<meta property="og:url" content="${url}">`,
      `<meta property="og:image" content="${SITE}/assets/ogp.png">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:alt" content="全銀ポン — Excelの振込一覧を、全銀フォーマットに変換">',
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${esc(title)}">`,
      `<meta name="twitter:description" content="${esc(description)}">`,
      `<meta name="twitter:image" content="${SITE}/assets/ogp.png">`,
    );
  }
  return lines.join('\n');
}

/** パンくず。trail = [['全銀フォーマットとは', '/zengin-format.html'], ...]（トップは自動で付く） */
function breadcrumbLd(trail) {
  const items = [['ホーム', '/']].concat(trail || []);
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + p })),
  };
}
function breadcrumbHtml(trail) {
  if (!trail || !trail.length) return '';
  const items = [['ホーム', '/']].concat(trail);
  return `<nav class="crumbs wrap" aria-label="現在位置"><ol>${items.map(([n, p], i) => (i === items.length - 1
    ? `<li aria-current="page">${esc(n)}</li>` : `<li><a href="${p}">${esc(n)}</a></li>`)).join('')}</ol></nav>`;
}

const ORG_LD = {
  // @id は会社サイト（kokokikaku.com）のトップにある Organization と同じ値にする。同じ組織だと機械に伝わる
  '@type': 'Organization', '@id': ORG.url + '#organization', name: ORG.name, alternateName: 'kokokikaku', url: ORG.url, email: ORG.email,
  slogan: '店のしごと、少しだけ軽くする。', sameAs: ['https://www.instagram.com/koko_kikaku/'],
};

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

module.exports = { SITE, SITE_NAME, ORG, NAV, esc, header, footer, headCommon, breadcrumbLd, breadcrumbHtml, ORG_LD, ld };
