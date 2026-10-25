const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const dir = path.join(__dirname, 'fixtures/fb-reader'), manifest = require('./fixtures/fb-reader/manifest.json');
test('nine valid-profile fixtures have independent byte offsets, record order, count and sum', () => {
  const valid = manifest.filter(x => x.expect === 'accept'); assert.equal(valid.length, 9);
  for (const item of valid) {
    const raw = fs.readFileSync(path.join(dir, item.name));
    const nl = item.name.includes('-CRLF') ? 2 : item.name.includes('-LF') ? 1 : 0;
    assert.equal(raw.length, 4 * (120 + nl));
    const rs = Array.from({ length: 4 }, (_, i) => raw.subarray(i * (120 + nl), i * (120 + nl) + 120));
    assert.deepEqual(rs.map(r => String.fromCharCode(r[0])), ['1', '2', '8', '9']);
    assert.equal(rs[0].subarray(1, 3).toString('ascii'), item.name.slice(0, 2));
    assert.equal(rs[1].subarray(20, 23).toString('ascii'), '001');
    assert.equal(rs[1].subarray(43, 50).toString('ascii'), '1234567');
    assert.equal(Number(rs[1].subarray(80, 90).toString('ascii')), 1000);
    assert.equal(Number(rs[2].subarray(1, 7).toString('ascii')), 1);
    assert.equal(Number(rs[2].subarray(7, 19).toString('ascii')), 1000);
  }
});
test('reject-profile fixtures exist with explicit expected causes; parser is not implemented yet', () => {
  const invalid = manifest.filter(x => x.expect === 'reject'); assert.equal(invalid.length, 9);
  invalid.forEach(x => { assert.ok(x.reason); assert.ok(fs.statSync(path.join(dir, x.name)).size > 0); });
});
