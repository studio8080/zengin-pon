'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const code = fs.readFileSync(require('node:path').join(__dirname, '../analytics.js'), 'utf8');
function run(overrides = {}) {
  const loads = [], handlers = {}, writes = [];
  const document = { title: '全銀ポン', referrer: 'https://example.com/private?account=PRIVATE#SECRET', cookie: '',
    getElementById: (id) => id === 'analytics-optout' ? { addEventListener: (name, fn) => { handlers[name] = fn; } } : { textContent: '' },
    createElement: () => ({}), head: { appendChild: (script) => loads.push(script.src) } };
  const ctx = { document, location: { origin: 'https://zenginpon.kokokikaku.com', pathname: '/', hostname: 'zenginpon.kokokikaku.com', href: 'https://zenginpon.kokokikaku.com/?session_id=SECRET#PRIVATE' },
    navigator: {}, localStorage: { getItem: () => null, setItem: (...args) => writes.push(args) }, URL, ...overrides };
  ctx.window = ctx; vm.runInNewContext(code, ctx);
  return { ctx, loads, handlers, writes };
}
const normal = run();
assert.equal(normal.loads.length, 1);
const sent = JSON.stringify(normal.ctx.dataLayer.map((item) => Array.from(item)));
assert(!/SECRET|PRIVATE|session_id|account=/.test(sent));
const events = normal.ctx.dataLayer.filter((item) => item[0] === 'event');
assert.equal(events.length, 1);
assert.equal(events[0][1], 'page_view');
assert.equal(events[0][2].page_referrer, 'https://example.com/');
for (const overrides of [{ navigator: { doNotTrack: '1' } }, { navigator: { globalPrivacyControl: true } }, { localStorage: { getItem: () => '1' } }]) {
  const disabled = run(overrides); assert.equal(disabled.loads.length, 0); assert.equal(disabled.ctx.dataLayer, undefined);
}
normal.handlers.click();
assert.equal(normal.ctx['ga-disable-G-13WS8YJMBV'], true);
assert.equal(normal.writes[0][1], '1');
console.log('Analytics privacy checks passed: URL/referrer redaction, single page view, DNT/GPC/opt-out.');
