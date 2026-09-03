#!/usr/bin/env node
/*
 * 金融機関辞書のビルド
 *
 *   node tools/build-dict.js [zengin-code の source-data ディレクトリ]
 *
 * 引数を省略すると GitHub から最新の tarball を取得して一時ディレクトリに展開する。
 * 出力:
 *   data/banks.json           { version, banks: { "0005": ["三菱ＵＦＪ", "ミツビシユ－エフジエイ"], ... } }
 *   data/branches/0005.json   { "001": ["本店", "ホンテン"], ... }
 *   data/version.json         { version: "2026-08-24", banks: 1234, source: "zengin-code/source-data" }
 *
 * 元データ: https://github.com/zengin-code/source-data （MIT License）
 * 全銀協の公開ページから機械的に収集されたもので、ほぼ毎月更新されている。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data');
const TARBALL = 'https://github.com/zengin-code/source-data/archive/refs/heads/master.tar.gz';

function fetchSource() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zengin-'));
  console.log('downloading', TARBALL);
  execSync(`curl -sL -o "${path.join(tmp, 'src.tar.gz')}" ${TARBALL}`, { stdio: 'inherit' });
  execSync(`tar xzf "${path.join(tmp, 'src.tar.gz')}" -C "${tmp}"`, { stdio: 'inherit' });
  return path.join(tmp, 'source-data-master');
}

function main() {
  const src = process.argv[2] ? path.resolve(process.argv[2]) : fetchSource();
  const banksSrc = JSON.parse(fs.readFileSync(path.join(src, 'data', 'banks.json'), 'utf8'));

  // 版数: git のコミット日が取れないので、データ内容のハッシュと今日の日付を使う
  let version = process.env.DICT_VERSION || new Date().toISOString().slice(0, 10);
  try {
    const log = execSync(`git -C "${src}" log -1 --format=%cs`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (log) version = log;
  } catch (_) { /* tarball には .git が無い */ }

  fs.mkdirSync(path.join(OUT, 'branches'), { recursive: true });
  const banks = {};
  let branchCount = 0;
  for (const code of Object.keys(banksSrc).sort()) {
    const b = banksSrc[code];
    banks[code] = [b.name, b.kana];
    const bf = path.join(src, 'data', 'branches', `${code}.json`);
    if (!fs.existsSync(bf)) continue;
    const brSrc = JSON.parse(fs.readFileSync(bf, 'utf8'));
    const br = {};
    for (const bc of Object.keys(brSrc).sort()) { br[bc] = [brSrc[bc].name, brSrc[bc].kana]; branchCount++; }
    fs.writeFileSync(path.join(OUT, 'branches', `${code}.json`), JSON.stringify(br));
  }
  fs.writeFileSync(path.join(OUT, 'banks.json'), JSON.stringify({ version, banks }));
  const meta = { version, banks: Object.keys(banks).length, branches: branchCount, source: 'zengin-code/source-data', builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log('built', meta);
}

main();
