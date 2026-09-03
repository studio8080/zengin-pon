#!/usr/bin/env node
/*
 * 銀行コード検索ページと sitemap.xml の生成（アクセス対策・SEO用の静的ページ）
 *
 *   node tools/build-bank-pages.js
 *
 * 出力:
 *   banks/index.html        全金融機関の一覧＋ブラウザ内検索
 *   banks/XXXX.html         金融機関ごとのページ（支店一覧つき）。「○○銀行 △△支店 支店コード」検索の受け皿
 *   sitemap.xml
 *
 * data/ は tools/build-dict.js で先に生成しておくこと。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://zenginpon.kokokikaku.com';
const banksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'banks.json'), 'utf8'));
const version = banksJson.version;
const banks = banksJson.banks;
const outDir = path.join(ROOT, 'banks');
fs.mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function kindOf(code) {
  if (code === '9900') return '銀行';
  if (code < '1000') return '銀行';
  if (code < '2000') return '信用金庫';
  if (code < '2951') return '信用組合';
  if (code < '3000') return '労働金庫';
  return '農協・漁協など';
}
function fullName(code, name) {
  const k = kindOf(code);
  if (k === '銀行') return /銀行$/.test(name) ? name : `${name}銀行`;
  if (k === '信用金庫') return /信用金庫$/.test(name) ? name : `${name}信用金庫`;
  if (k === '信用組合') return /信用組合$/.test(name) ? name : `${name}信用組合`;
  if (k === '労働金庫') return /労働金庫$/.test(name) ? name : `${name}労働金庫`;
  return name;
}

function page({ title, description, body, canonical, jsonld }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../style.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head>
<body data-depth="1">
${body}
<script src="../src/site.js"></script>
</body>
</html>
`;
}

const cta = `<div class="callout ok" style="margin-top:28px"><strong>このコードで振込データを作る:</strong> Excelの支払リストや給与計算表を、銀行名・支店名のままでも読み込んで全銀フォーマットに変換できます。<a href="../index.html#tool">全銀ポン（無料）</a></div>`;

// ---- 各銀行ページ ----
const urls = [];
let branchTotal = 0;
for (const code of Object.keys(banks).sort()) {
  const [name, kana] = banks[code];
  const fn = fullName(code, name);
  let branches = {};
  const bf = path.join(ROOT, 'data', 'branches', `${code}.json`);
  if (fs.existsSync(bf)) branches = JSON.parse(fs.readFileSync(bf, 'utf8'));
  const list = Object.keys(branches).sort();
  branchTotal += list.length;
  const rows = list.map((bc) => `<tr><td class="mono">${bc}</td><td>${esc(branches[bc][0])}</td><td>${esc(branches[bc][1])}</td></tr>`).join('\n');
  const body = `<article class="article">
  <p class="updated"><a href="index.html">銀行コード検索</a> › ${esc(fn)}</p>
  <h1>${esc(fn)}の銀行コード・支店コード一覧</h1>
  <p class="updated">金融機関コード <strong class="mono">${code}</strong> ／ カナ: ${esc(kana)} ／ ${list.length} 支店 ／ ${version} 版の全銀協公開データに基づく</p>
  <div class="callout">振込データ（全銀フォーマット）では、この <strong>金融機関コード ${code}</strong> と下の <strong>3桁の支店コード</strong> を使います。銀行名・支店名は任意項目で、コードから自動で判定されます。</div>
  <p><input id="q" type="search" placeholder="支店名・支店コードで絞り込み" style="width:100%;max-width:420px"></p>
  <div class="tablewrap"><table id="t"><thead><tr><th>支店コード</th><th>支店名</th><th>カナ</th></tr></thead><tbody>
${rows}
  </tbody></table></div>
  ${cta}
  <p class="hint">支店の新設・統廃合により最新の情報と異なる場合があります。正確な情報は各金融機関にご確認ください。</p>
</article>
<script>
(function(){var q=document.getElementById('q'),rows=[].slice.call(document.querySelectorAll('#t tbody tr'));q.addEventListener('input',function(){var v=q.value.trim().toLowerCase();rows.forEach(function(r){r.style.display=!v||r.textContent.toLowerCase().indexOf(v)>=0?'':'none';});});})();
</script>`;
  const url = `${SITE}/banks/${code}.html`;
  fs.writeFileSync(path.join(outDir, `${code}.html`), page({
    title: `${fn}の銀行コード（${code}）と支店コード一覧｜全銀ポン`,
    description: `${fn}（金融機関コード ${code}）の支店コード・支店名の一覧。振込データ（全銀フォーマット）作成に必要な4桁の銀行コードと3桁の支店コードを確認できます。`,
    canonical: url,
    jsonld: { '@context': 'https://schema.org', '@type': 'Dataset', name: `${fn}の支店コード一覧`, description: `金融機関コード ${code} の支店コード一覧（${version}版）`, license: 'https://opensource.org/licenses/MIT', creator: { '@type': 'Organization', name: 'ここ企画' } },
    body,
  }));
  urls.push(url);
}

// ---- 一覧（検索）ページ ----
const groups = {};
for (const code of Object.keys(banks).sort()) { const k = kindOf(code); (groups[k] = groups[k] || []).push(code); }
const groupHtml = Object.entries(groups).map(([k, codes]) => `<h2 id="${esc(k)}">${esc(k)}（${codes.length}）</h2>
<ul class="banklist">${codes.map((c) => `<li data-s="${esc(c + ' ' + banks[c][0] + ' ' + banks[c][1])}"><a href="${c}.html"><span class="mono">${c}</span> ${esc(fullName(c, banks[c][0]))}</a></li>`).join('')}</ul>`).join('\n');
const indexBody = `<article class="article" style="max-width:960px">
  <h1>銀行コード・支店コード検索</h1>
  <p class="updated">全国 ${Object.keys(banks).length} 金融機関・${branchTotal.toLocaleString()} 支店。${version} 版の全銀協公開データ（毎月更新）に基づく</p>
  <p><input id="q" type="search" placeholder="銀行名・カナ・コードで検索（例: みずほ、1610、ゆうちょ）" style="width:100%;max-width:520px;font-size:16px"></p>
  <div class="callout">振込データ（全銀フォーマット）に必要なのは <strong>4桁の金融機関コード</strong> と <strong>3桁の支店コード</strong> です。金融機関名をクリックすると支店コードの一覧が見られます。</div>
  <style>.banklist{list-style:none;padding:0;columns:3;column-gap:20px;font-size:14px}.banklist li{break-inside:avoid;margin:2px 0}.banklist a{text-decoration:none;color:var(--ink)}.banklist a:hover{color:var(--navy-2)}@media(max-width:700px){.banklist{columns:1}}</style>
  ${groupHtml}
  ${cta}
</article>
<script>
(function(){var q=document.getElementById('q'),items=[].slice.call(document.querySelectorAll('.banklist li')),heads=[].slice.call(document.querySelectorAll('h2'));function norm(s){return s.toLowerCase().replace(/[\\s　]/g,'').replace(/[ぁ-ゖ]/g,function(c){return String.fromCharCode(c.charCodeAt(0)+96)}).replace(/[！-～]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-65248)})}q.addEventListener('input',function(){var v=norm(q.value);items.forEach(function(li){li.style.display=!v||norm(li.getAttribute('data-s')).indexOf(v)>=0?'':'none';});heads.forEach(function(h){var ul=h.nextElementSibling;h.style.display=[].some.call(ul.children,function(li){return li.style.display!=='none'})?'':'none';});});})();
</script>`;
fs.writeFileSync(path.join(outDir, 'index.html'), page({
  title: '銀行コード・支店コード検索（全国の金融機関一覧）｜全銀ポン',
  description: `全国${Object.keys(banks).length}金融機関の銀行コード（金融機関コード）と支店コードを検索。振込データ・全銀フォーマットの作成に。${version}版の全銀協公開データに基づき毎月更新。`,
  canonical: `${SITE}/banks/`,
  body: indexBody,
}));

// ---- sitemap ----
const statics = ['', 'guide.html', 'pricing.html', 'security.html', 'faq.html', 'banks/'];
const today = new Date().toISOString().slice(0, 10);
const sm = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${statics.map((p) => `  <url><loc>${SITE}/${p}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${p === '' ? '1.0' : '0.8'}</priority></url>`).join('\n')}
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${version}</lastmod><changefreq>monthly</changefreq><priority>0.4</priority></url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sm);
console.log(`built ${urls.length} bank pages, ${branchTotal} branches, sitemap with ${urls.length + statics.length} urls`);
