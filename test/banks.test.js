'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../src/banks.js'), 'utf8');

function element(textContent = '') {
  const el = { textContent, style: {}, hidden: true, handlers: {}, value: '',
    addEventListener(type, fn) { this.handlers[type] = fn; },
    focus() { this.focused = true; } };
  Object.defineProperty(el, 'innerHTML', { set() { throw new Error('Search must not insert HTML'); } });
  return el;
}
function fixture({ pilot = true, index = false, initial = '' } = {}) {
  const q = element(); q.value = initial;
  const rows = [element('001 本店 ホンテン'), element('022 銀座 ギンザ'), element('735 神戸 コウベ')];
  const count = element(), empty = element(), reset = element();
  const items = index ? [element(), element()] : [];
  items.forEach((li, i) => { li.getAttribute = () => i ? '0175 四国 シコク' : '0300 ＳＭＢＣ信託 エスエムビーシーシンタク'; });
  const heads = items.map(li => ({ style: {}, nextElementSibling: { children: [li] } }));
  const ids = { q, ...(pilot ? { 'search-count': count, 'search-empty': empty, 'search-reset': reset } : {}) };
  vm.runInNewContext(script, { document: {
    getElementById(id) { return ids[id] || null; },
    querySelectorAll(selector) { return selector === '.banklist li' ? items : selector === 'h2' ? heads : rows; }
  } });
  return { q, rows, count, empty, reset, items, heads,
    search(value) { q.value = value; q.handlers.input(); },
    visible() { return rows.filter(row => row.style.display !== 'none'); } };
}

test('branch search accepts hiragana, halfwidth kana, voiced kana and fullwidth codes', () => {
  const f = fixture();
  for (const query of ['銀座', 'ぎんざ', 'ギンザ', 'ｷﾞﾝｻﾞ', '０２２', ' ０２２　']) {
    f.search(query);
    assert.equal(f.visible().length, 1, query);
    assert.match(f.visible()[0].textContent, /022/);
    assert.equal(f.count.textContent, '3支店中1支店を表示');
    assert.equal(f.empty.hidden, true);
  }
});
test('no match is explicit and reset restores all rows and keyboard focus', () => {
  const f = fixture();
  f.search('該当しない支店');
  assert.equal(f.visible().length, 0);
  assert.equal(f.count.textContent, '3支店中0支店を表示');
  assert.equal(f.empty.hidden, false);
  assert.equal(f.reset.hidden, false);
  f.reset.handlers.click();
  assert.equal(f.q.value, '');
  assert.equal(f.visible().length, 3);
  assert.equal(f.count.textContent, '3支店を表示');
  assert.equal(f.empty.hidden, true);
  assert.equal(f.reset.hidden, true);
  assert.equal(f.q.focused, true);
});
test('restored input is applied at startup; whitespace restores the complete list', () => {
  const f = fixture({ initial: 'ほんてん' });
  assert.equal(f.visible().length, 1);
  f.search('　 ');
  assert.equal(f.visible().length, 3);
  assert.equal(f.reset.hidden, true);
});
test('other bank pages without the new controls still filter', () => {
  const f = fixture({ pilot: false });
  f.search('こうべ');
  assert.equal(f.visible().length, 1);
  f.search('');
  assert.equal(f.visible().length, 3);
});
test('bank index continues to filter and hide empty categories', () => {
  const f = fixture({ index: true });
  f.search('ｼｺｸ');
  assert.equal(f.items[0].style.display, 'none');
  assert.equal(f.items[1].style.display, '');
  assert.equal(f.heads[0].style.display, 'none');
  f.search('smbc');
  assert.equal(f.items[0].style.display, '');
  assert.equal(f.items[1].style.display, 'none');
  f.search('');
  assert.ok(f.items.every(li => li.style.display === ''));
  assert.ok(f.heads.every(h => h.style.display === ''));
});
test('pages without a bank search field are unaffected', () => {
  assert.doesNotThrow(() => vm.runInNewContext(script, { document: { getElementById: () => null } }));
});
test('HTML-looking search input stays a literal filter and is never echoed into results', () => {
  const f = fixture();
  f.search('\"><img src=x onerror=alert(1)>');
  assert.equal(f.visible().length, 0);
  assert.equal(f.count.textContent, '3支店中0支店を表示');
  assert.equal(f.empty.hidden, false);
  assert.ok(!f.count.textContent.includes('<'));
  f.reset.handlers.click();
  assert.equal(f.visible().length, 3);
});
test('generated search placeholder escapes both branch name and branch code', () => {
  const output = new Map();
  const branchCode = '001" onfocus="alert(1)';
  const branchName = '<img src=x onerror=alert(1)>';
  const fakeFs = {
    mkdirSync() {}, existsSync() { return true; },
    readFileSync(file) {
      if (file.endsWith('banks.json')) return JSON.stringify({ version: '2026-08-24', banks: { '0300': ['テスト', 'テスト'] } });
      return JSON.stringify({ [branchCode]: [branchName, 'テスト'] });
    },
    writeFileSync(file, contents) { output.set(path.basename(file), contents); }
  };
  const generator = fs.readFileSync(path.join(__dirname, '../tools/build-bank-pages.js'), 'utf8');
  vm.runInNewContext(generator, {
    __dirname: path.join(__dirname, '../tools'), console: { log() {} },
    require(id) {
      if (id === 'node:fs') return fakeFs;
      if (id === 'node:path') return path;
      if (id === './site-template') return require('../tools/site-template');
      throw new Error('Unexpected dependency: ' + id);
    }
  });
  const placeholder = output.get('0300.html').match(/<input id="q"[^>]*placeholder="([^"]*)"/)[1];
  assert.equal(placeholder, '例: &lt;img src=x onerror=alert(1)&gt;、001&quot; onfocus=&quot;alert(1)');
});
