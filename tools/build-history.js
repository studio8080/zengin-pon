#!/usr/bin/env node
/*
 * build-history.js — 金融機関・支店の「消えた／名前が変わった／番号が変わった」履歴を作る
 *
 *   node tools/build-history.js <zengin-code/source-data の git クローン（履歴つき）>
 *
 * zengin-code/source-data は「いまの一覧」しか持たないが、git の履歴には過去の版が残っている。
 * 版と版を比べて、次の出来事を data/history.json に書き出す。
 *   removed  … その版で一覧から消えた（廃止・統合・店舗内店舗への移行など）
 *   renamed  … 同じコードのまま名前が変わった
 *   moved    … 消えたのと同じ版で、同じ名前の支店が別のコードで現れた（番号の振り直し）
 * 画面では、表のコードがいまの一覧に無いときや、旧名で書かれていたときに、この履歴から案内を出す。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node tools/build-history.js <source-data clone>'); process.exit(2); }
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'history');
const git = (...args) => execFileSync('git', ['-C', SRC, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const show = (rev, file) => { try { return JSON.parse(git('show', `${rev}:${file}`)); } catch (_) { return null; } };
const brief = (o) => (o ? [o.name, o.kana] : null);

// 一覧を更新した版だけを古い順に（マージや依存関係の更新は除く）
const commits = git('log', '--first-parent', '--reverse', '--format=%H %cs %s', '--', 'data/banks.json', 'data/branches')
  .trim().split('\n').map((l) => { const [h, d] = l.split(' '); return { h, d }; });

const banks = {};     // code → [{ d, t, name, kana, was }]
const branches = {};  // bankCode → branchCode → [{ d, t, name, kana, was, to }]
const push = (obj, k, ev) => { (obj[k] = obj[k] || []).push(ev); };

for (let i = 1; i < commits.length; i++) {
  const prev = commits[i - 1], cur = commits[i];
  const changed = git('diff', '--name-status', prev.h, cur.h, '--', 'data/banks.json', 'data/branches').trim();
  if (!changed) continue;
  for (const line of changed.split('\n')) {
    const [st, file] = line.split('\t');
    if (file === 'data/banks.json') {
      const a = show(prev.h, file) || {}, b = show(cur.h, file) || {};
      for (const code of Object.keys(a)) {
        if (!b[code]) push(banks, code, { d: cur.d, t: 'removed', name: a[code].name, kana: a[code].kana });
        else if (a[code].name !== b[code].name) push(banks, code, { d: cur.d, t: 'renamed', name: b[code].name, kana: b[code].kana, was: a[code].name });
      }
      continue;
    }
    const m = file.match(/^data\/branches\/(\d{4})\.json$/);
    if (!m) continue;
    const bank = m[1];
    const a = st === 'A' ? {} : (show(prev.h, file) || {});
    const b = st === 'D' ? {} : (show(cur.h, file) || {});
    const byName = {};
    for (const [code, o] of Object.entries(b)) if (!a[code]) byName[o.name] = code;   // この版で増えた支店
    const tb = (branches[bank] = branches[bank] || {});
    for (const [code, o] of Object.entries(a)) {
      if (!b[code]) {
        const to = byName[o.name];
        push(tb, code, to ? { d: cur.d, t: 'moved', name: o.name, kana: o.kana, to } : { d: cur.d, t: 'removed', name: o.name, kana: o.kana });
      } else if (a[code].name !== b[code].name) {
        push(tb, code, { d: cur.d, t: 'renamed', name: b[code].name, kana: b[code].kana, was: a[code].name });
      }
    }
    if (!Object.keys(tb).length) delete branches[bank];
  }
}

// 銀行ごとのファイルに分ける（画面は必要な銀行の分だけ読む）。banks.json は金融機関そのものの履歴と、支店の履歴がある銀行の一覧
const latest = commits[commits.length - 1];
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [bank, evs] of Object.entries(branches)) fs.writeFileSync(path.join(OUT_DIR, `${bank}.json`), JSON.stringify(evs));
const index = { version: latest.d, since: commits[0].d, source: 'zengin-code/source-data (git history)', banks, branchFiles: Object.keys(branches).sort() };
fs.writeFileSync(path.join(OUT_DIR, 'banks.json'), JSON.stringify(index));
const OUT = path.join(OUT_DIR, 'banks.json');
const nBr = Object.values(branches).reduce((s, x) => s + Object.keys(x).length, 0);
const count = (t) => Object.values(branches).reduce((s, x) => s + Object.values(x).filter((evs) => evs.some((e) => e.t === t)).length, 0);
console.log(`history ${index.since} → ${index.version}: banks ${Object.keys(banks).length}, branches ${nBr} (removed ${count('removed')}, moved ${count('moved')}, renamed ${count('renamed')}), ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
