#!/usr/bin/env node
/*
 * build-site.js — 手書きの各ページに、共通のヘッダー・フッター・<head>共通部・構造化データを埋め込む
 *
 *   node tools/build-site.js          すべてのページを更新し、sitemap.xml も作り直す
 *   node tools/build-site.js --check  差分があれば終了コード1（CI用。埋め込み忘れの検出）
 *
 * 各ページの次の目印のあいだを書き換える（目印が無ければ初回に自動で挿入する）。
 *   <!-- site:head -->   … <!-- /site:head -->      アイコン・OGP など
 *   <!-- site:ld -->     … <!-- /site:ld -->        パンくず等の構造化データ
 *   <!-- site:header --> … <!-- /site:header -->    ヘッダーとパンくず
 *   <!-- site:footer --> … <!-- /site:footer -->    フッター
 *
 * ページを追加したら下の PAGES に1行足してこのスクリプトを実行する。
 * 銀行コードのページ（banks/）は tools/build-bank-pages.js が同じ部品を使って生成する。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const T = require('./site-template');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

// file: リポジトリ内のパス / url: 公開パス / trail: パンくず / sitemap: 優先度（無ければ載せない）
const PAGES = [
  { file: 'index.html', url: '/', type: 'website', sitemap: '1.0', extraLd: () => [{ '@context': 'https://schema.org', '@graph': [
    T.ORG_LD,
    { '@type': 'WebSite', '@id': T.SITE + '/#website', url: T.SITE + '/', name: T.SITE_NAME, alternateName: ['全銀ポン 全銀フォーマット変換ツール', 'ぜんぎんポン'], inLanguage: 'ja', publisher: { '@id': T.ORG.url + '#organization' } },
    { '@type': 'WebApplication', '@id': T.SITE + '/#app', name: T.SITE_NAME, url: T.SITE + '/', applicationCategory: 'BusinessApplication', applicationSubCategory: '振込データ作成', operatingSystem: 'Web（Chrome / Edge / Safari / Firefox の最新版）', inLanguage: 'ja', isAccessibleForFree: true,
      description: '給与振込・総合振込のExcel／CSV／PDF／Googleスプレッドシートを、ネットバンキングに取り込める全銀フォーマット（FBデータ）に変換するツール。変換はブラウザの中だけで行い、振込データをサーバーに送信しない。',
      featureList: ['Excel・CSV・PDF・Googleスプレッドシートの読み込み', '列の並びや見出しが違う表の自動整理', '銀行名・支店名からの金融機関コードの補完', '口座名義の半角カナ・法人略語への変換', 'ゆうちょ銀行の記号番号の変換', '銀行休業日の確認', '総合振込・給与振込・賞与振込に対応'],
      offers: [
        { '@type': 'Offer', name: 'Free（1回20件まで）', price: '0', priceCurrency: 'JPY' },
        { '@type': 'Offer', name: 'Pro（月払い）', price: '480', priceCurrency: 'JPY' },
        { '@type': 'Offer', name: 'Pro（年払い）', price: '4800', priceCurrency: 'JPY' },
      ],
      creator: { '@id': T.ORG.url + '#organization' }, publisher: { '@id': T.ORG.url + '#organization' } },
  ] }] },
  { file: 'guide.html', url: '/guide.html', trail: [['使い方・銀行別の取込方法', '/guide.html']], sitemap: '0.8' },
  { file: 'zengin-format.html', url: '/zengin-format.html', trail: [['全銀フォーマットとは', '/zengin-format.html']], sitemap: '0.9' },
  { file: 'pricing.html', url: '/pricing.html', trail: [['料金プラン', '/pricing.html']], sitemap: '0.8' },
  { file: 'security.html', url: '/security.html', trail: [['セキュリティとデータの扱い', '/security.html']], sitemap: '0.8' },
  { file: 'legal.html', url: '/legal.html', trail: [['法令上の位置づけ', '/legal.html']], sitemap: '0.6' },
  { file: 'faq.html', url: '/faq.html', trail: [['よくある質問', '/faq.html']], sitemap: '0.8' },
  { file: 'about.html', url: '/about.html', trail: [['運営者情報', '/about.html']], sitemap: '0.7' },
  { file: 'accessibility.html', url: '/accessibility.html', trail: [['アクセシビリティ', '/accessibility.html']], sitemap: '0.3' },
  { file: 'free-tools/index.html', url: '/free-tools/', trail: [['無料ツール', '/free-tools/']], sitemap: '0.8' },
  { file: 'free-tools/yucho.html', url: '/free-tools/yucho.html', trail: [['無料ツール', '/free-tools/'], ['ゆうちょ 記号番号の変換', '/free-tools/yucho.html']], sitemap: '0.9' },
  { file: 'free-tools/kana.html', url: '/free-tools/kana.html', trail: [['無料ツール', '/free-tools/'], ['口座名義のカナ変換', '/free-tools/kana.html']], sitemap: '0.9' },
  { file: 'terms.html', url: '/terms.html', trail: [['利用規約', '/terms.html']], noindex: true },
  { file: 'privacy.html', url: '/privacy.html', trail: [['プライバシーポリシー', '/privacy.html']], noindex: true },
  { file: 'tokushoho.html', url: '/tokushoho.html', trail: [['特定商取引法に基づく表記', '/tokushoho.html']], noindex: true },
  { file: '404.html', url: '/404.html', noindex: true },
];

const block = (name, body) => `<!-- site:${name} -->\n${body}\n<!-- /site:${name} -->`;
const blockRe = (name) => new RegExp(`<!-- site:${name} -->[\\s\\S]*?<!-- /site:${name} -->`);

function stamp(html, page) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || T.SITE_NAME;
  const description = (html.match(/<meta name="description" content="([\s\S]*?)"/) || [])[1] || '';

  // --- 初回の移行: 手書きだった共通行を取り除く ---
  if (!blockRe('head').test(html)) {
    html = html
      .replace(/^\s*<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\s*\n/gm, '')
      .replace(/^\s*<meta name="(?:theme-color|twitter:card|referrer|format-detection)"[^>]*>\s*\n/gm, '')
      .replace(/^\s*<meta property="og:[^"]*"[^>]*>\s*\n/gm, '');
    html = html.replace(/(<meta name="viewport"[^>]*>)\s*\n?/, `$1\n${block('head', '')}\n`);
  }
  if (!blockRe('ld').test(html)) html = html.replace(/<\/head>/, `${block('ld', '')}\n</head>`);
  if (!blockRe('header').test(html)) html = html.replace(/(<body[^>]*>)\s*\n?/, `$1\n${block('header', '')}\n`);
  if (!blockRe('footer').test(html)) {
    // フッターは末尾のスクリプト群の直前に置く
    const m = html.match(/\n(<script src="[^"]*config\.js"><\/script>[\s\S]*?)?<\/body>/);
    if (!m) throw new Error(`${page.file}: </body> が見つかりません`);
    html = html.replace(m[0], `\n${block('footer', '')}${m[0]}`);
  }

  // --- 埋め込み ---
  const lds = [];
  if (page.trail) lds.push(T.breadcrumbLd(page.trail));
  if (page.extraLd) lds.push(...page.extraLd());
  html = html.replace(blockRe('head'), block('head', T.headCommon({ title, description, path: page.url, type: page.type, noindex: page.noindex })));
  html = html.replace(blockRe('ld'), block('ld', lds.map(T.ld).join('\n')));
  html = html.replace(blockRe('header'), block('header', `${T.header(page.url)}\n${T.breadcrumbHtml(page.trail)}\n<span id="main" tabindex="-1"></span>`));
  html = html.replace(blockRe('footer'), block('footer', T.footer()));
  return html;
}

function lastmod(file) {
  // 未コミットの変更があるファイルは「今日」、それ以外は最後にコミットした日。
  // 変えていないページの日付を今日にしない（検索エンジンに嘘の更新日を伝えないため）。
  try {
    const dirty = execSync(`git status --porcelain -- "${file}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (dirty) return new Date().toISOString().slice(0, 10);
  } catch (_) { /* git が無い環境 */ }
  try {
    const d = execSync(`git log -1 --format=%cs -- "${file}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (d) return d;
  } catch (_) { /* git が無い環境 */ }
  return new Date().toISOString().slice(0, 10);
}

function buildSitemap() {
  const urls = PAGES.filter((p) => p.sitemap && fs.existsSync(path.join(ROOT, p.file)))
    .map((p) => `  <url><loc>${T.SITE}${p.url}</loc><lastmod>${lastmod(p.file)}</lastmod><priority>${p.sitemap}</priority></url>`);
  // 銀行ページ
  const banksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'banks.json'), 'utf8'));
  urls.push(`  <url><loc>${T.SITE}/banks/</loc><lastmod>${banksJson.version}</lastmod><priority>0.8</priority></url>`);
  for (const code of Object.keys(banksJson.banks).sort()) {
    urls.push(`  <url><loc>${T.SITE}/banks/${code}.html</loc><lastmod>${banksJson.version}</lastmod><priority>0.4</priority></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

let changed = 0, missing = [];
for (const page of PAGES) {
  const f = path.join(ROOT, page.file);
  if (!fs.existsSync(f)) { missing.push(page.file); continue; }
  const before = fs.readFileSync(f, 'utf8');
  const after = stamp(before, page);
  if (after !== before) { changed++; if (!CHECK) fs.writeFileSync(f, after); }
}
const sm = buildSitemap();
const smFile = path.join(ROOT, 'sitemap.xml');
// --check では sitemap を比べない（lastmod はコミットの前後で変わるのが正常なため）
if (!CHECK && (!fs.existsSync(smFile) || fs.readFileSync(smFile, 'utf8') !== sm)) { changed++; fs.writeFileSync(smFile, sm); }

if (missing.length) console.log('まだ無いページ（スキップ）:', missing.join(', '));
console.log(CHECK ? `差分のあるファイル: ${changed}` : `更新したファイル: ${changed}`);
if (CHECK && changed) process.exit(1);
