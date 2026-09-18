#!/usr/bin/env node
/*
 * IndexNow: 公開・更新したページの URL を Bing などの検索エンジンへ知らせる（Google は非対応）。
 * Bing の索引は Copilot や ChatGPT の検索にも使われるので、新しいページが早く見つかるようになる。
 *
 *   node tools/indexnow.js             sitemap.xml の全 URL を送る（初回・大きな変更のあと）
 *   node tools/indexnow.js --changed   直近のコミットで変わったページだけ送る（ふだんはこちら）
 *
 * キーは リポジトリ直下の <key>.txt に置いて公開する（IndexNow の仕様。秘密ではない）。
 * push して GitHub Pages に反映されてから実行すること（反映前に送ると 404 を知らせることになる）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'zenginpon.kokokikaku.com';
const KEY = '7cedf606b91c1eada5ba649d5863b603';

let urls = [...fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

if (process.argv.includes('--changed')) {
  let changed = [];
  try { changed = execSync('git diff --name-only HEAD~1 HEAD', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (_) { /* 履歴が無い */ }
  // 共通部品が変わったら全ページが変わっているので全件送る
  const wide = changed.some((f) => /^(tools\/site-template\.js|style\.css)$/.test(f));
  if (!wide) {
    const paths = new Set(changed.filter((f) => f.endsWith('.html')).map((f) => '/' + f.replace(/(^|\/)index\.html$/, '$1')));
    urls = urls.filter((u) => paths.has(new URL(u).pathname));
  }
}
if (!urls.length) { console.log('IndexNow: 送る URL なし'); process.exit(0); }

(async () => {
  const body = { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls.slice(0, 10000) };
  const res = await fetch('https://api.indexnow.org/IndexNow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  console.log(`IndexNow: ${urls.length} URL → HTTP ${res.status}`);
  if (res.status >= 400) process.exit(1);
})();
