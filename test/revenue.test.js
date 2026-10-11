'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../analytics.js'), 'utf8');

function fixture(pagePath = '/guide.html', options = {}) {
  const listeners = [], optHandlers = {}, loads = [];
  let optedOut = options.optedOut || false;
  const ctx = {
    location: { origin: 'https://zenginpon.kokokikaku.com', pathname: pagePath,
      hostname: 'zenginpon.kokokikaku.com', href: 'https://zenginpon.kokokikaku.com'+pagePath+'?account=PRIVATE#SECRET' },
    navigator: options.navigator || {}, URL,
    localStorage: { getItem(key) {
      assert.equal(key, 'zenginponAnalyticsOptOut', 'Never read a license or saved transfer data');
      if (options.storageError) throw new Error('unavailable');
      return optedOut ? '1' : null;
    }, setItem() { optedOut = true; } },
    document: { title: '公開の案内', referrer: 'https://example.com/private?name=PRIVATE#SECRET', cookie: '',
      getElementById: id => id === 'analytics-optout' ? { addEventListener: (event, fn) => { optHandlers[event] = fn; } } : null,
      addEventListener(event, fn) { assert.equal(event, 'click'); listeners.push(fn); },
      querySelector(selector) {
        assert.equal(selector, '.billing button.on', 'Never select an input, file or license');
        return { getAttribute: name => { assert.equal(name, 'data-cycle'); return options.cycle || 'month'; } };
      },
      createElement: () => ({}), head: { appendChild: script => loads.push(script.src) }
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  function click(action = 'tool', placement = 'article-end', disabled = false) {
    const attrs = { 'data-revenue-action': action, 'data-revenue-placement': placement,
      'aria-disabled': disabled ? 'true' : null };
    const link = { getAttribute(name) { assert(name in attrs); return attrs[name]; } };
    for (const prop of ['href', 'value', 'textContent', 'dataset']) {
      Object.defineProperty(link, prop, { get() { throw new Error('Sensitive or unbounded value read: '+prop); } });
    }
    const event = { target: { closest(selector) { assert.equal(selector, 'a[data-revenue-action]'); return link; } } };
    listeners.forEach(fn => fn(event));
  }
  return { ctx, listeners, optHandlers, loads, click, disable() { optedOut = true; },
    events: () => Array.from(ctx.dataLayer || []).filter(item => item[0] === 'event' && item[1] === 'revenue_action') };
}

test('public tool and Pro links report only fixed labels and clean source URL', () => {
  const f = fixture(); f.click(); f.click('pro');
  assert.equal(f.events().length, 2);
  assert.deepEqual(Array.from(Object.keys(f.events()[0][2])).sort(), ['action','page_location','page_referrer','placement']);
  assert.equal(f.events()[0][2].page_location, 'https://zenginpon.kokokikaku.com/guide.html');
  assert.equal(f.events()[0][2].page_referrer, '');
  assert(!/PRIVATE|SECRET|account|license/.test(JSON.stringify(f.ctx.dataLayer)));
});

test('checkout distinguishes monthly and yearly choices without reading payment URL', () => {
  for (const [cycle, plan] of [['month','monthly'],['year','yearly']]) {
    const f = fixture('/pricing.html', { cycle }); f.click('checkout','pricing-card');
    assert.equal(f.events().length, 1); assert.equal(f.events()[0][2].plan, plan);
  }
});

test('converter, input tools and bank searches keep page views only', () => {
  for (const page of ['/', '/index.html', '/free-tools/kana.html', '/free-tools/yucho.html', '/banks/', '/banks/0001.html']) {
    const f = fixture(page); f.click(); assert.equal(f.listeners.length, 0); assert.equal(f.events().length, 0);
    assert.equal(f.ctx.dataLayer.filter(x => x[0] === 'event').length, 1);
  }
});

test('unknown actions, placements, plan choices and disabled checkout produce no event', () => {
  const f = fixture('/pricing.html', { cycle: 'SECRET' });
  f.click('PRIVATE'); f.click('tool','PRIVATE'); f.click('checkout','pricing-card'); f.click('checkout','pricing-card',true);
  assert.equal(f.events().length, 0);
});

test('checkout only counts on the actual pricing card', () => {
  const guide = fixture(); guide.click('checkout','pricing-card'); assert.equal(guide.events().length, 0);
  const pricing = fixture('/pricing.html'); pricing.click('checkout','article-end'); assert.equal(pricing.events().length, 0);
});

test('initial opt-out, DNT and GPC load no analytics and install no tracking listener', () => {
  for (const options of [{ optedOut: true }, { navigator: { doNotTrack: '1' } }, { navigator: { globalPrivacyControl: true } }]) {
    const f = fixture('/guide.html', options); f.click(); assert.equal(f.loads.length, 0); assert.equal(f.listeners.length, 0);
  }
});

test('opt-out after loading immediately stops public link events', () => {
  const f = fixture(); f.click(); f.optHandlers.click(); f.click('pro'); assert.equal(f.events().length, 1);
  const otherTab = fixture(); otherTab.disable(); otherTab.click(); assert.equal(otherTab.events().length, 0);
});

test('DNT and GPC enabled after loading also stop events', () => {
  for (const key of ['doNotTrack','globalPrivacyControl']) {
    const f = fixture(); f.ctx.navigator[key] = key === 'doNotTrack' ? '1' : true;
    f.click(); assert.equal(f.events().length, 0);
  }
});

test('unavailable local storage fails closed', () => {
  const f = fixture('/guide.html', { storageError: true }); assert.equal(f.loads.length, 0);
  const later = fixture(); later.ctx.localStorage.getItem = () => { throw new Error('unavailable'); };
  assert.doesNotThrow(() => later.click()); assert.equal(later.events().length, 0);
});

test('duplicate script loading installs one listener and one page view', () => {
  const f = fixture(); vm.runInContext(code, f.ctx); f.click();
  assert.equal(f.loads.length, 1); assert.equal(f.listeners.length, 1); assert.equal(f.events().length, 1);
  assert.equal(f.ctx.dataLayer.filter(x => x[1] === 'page_view').length, 1);
});

test('non-link clicks and measurement failures never interrupt navigation', () => {
  const f = fixture();
  for (const event of [{target:null}, {target:{}}, {target:{closest:()=>null}}, {target:{closest:()=>{throw new Error('gone');}}}]) {
    assert.doesNotThrow(() => f.listeners[0](event));
  }
  f.ctx.dataLayer.push = () => { throw new Error('analytics unavailable'); };
  assert.doesNotThrow(() => f.click()); assert.equal(f.events().length, 0);
});

test('privacy pages and commercial navigation never infer purchase completion', () => {
  const f = fixture('/privacy.html'); f.click('checkout','pricing-card'); assert.equal(f.listeners.length, 0);
  const pricing = fixture('/pricing.html'); pricing.click('checkout','pricing-card');
  assert.equal(pricing.ctx.dataLayer.filter(x=>x[1]==='purchase').length, 0);
});
