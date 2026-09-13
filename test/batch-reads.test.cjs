'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(kind) {
  const file = path.join(__dirname, '../lib', kind === 'report' ? 'store.js' : 'services.js');
  const actual = createRequire(file);
  const state = { batches: [], active: 0, peak: 0, records: new Map(), fail: false, incomplete: false };
  const db = {
    getObject() { throw new Error('Unexpected individual read'); },
    async getObjects(keys) {
      state.batches.push(keys);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      await Promise.resolve();
      state.active--;
      if (state.fail && state.batches.length === 2) throw new Error('Database failure');
      if (state.incomplete) return [];
      return keys.map(key => state.records.get(key.split(':').pop()) || null);
    },
    getSortedSetRevRange: async () => [...state.records.keys()],
  };
  const req = name => name === './nodebb' ? { db, groups: {} } :
    name === './report-cas' || name === './upload' ? {} :
      name === './config' ? { getConfig: () => ({}) } : actual(name);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`)(req, module, module.exports);
  return { state, api: module.exports, read: kind === 'report' ? module.exports.getReports : module.exports.getServices };
}

for (const kind of ['report', 'service']) {
  test(`${kind}: 1000 records use ten sequential batches preserving order`, async () => {
    const f = fixture(kind);
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    ids.forEach(id => f.state.records.set(id, { id, public: '1', isPublic: '1', images: '[]' }));
    assert.deepEqual((await f.read(ids)).map(row => row.id), ids);
    assert.equal(f.state.batches.length, 10);
    assert.ok(f.state.batches.every(keys => keys.length === 100));
    assert.equal(f.state.peak, 1);
  });
  test(`${kind}: empty lists, missing records and final partial batch`, async () => {
    const f = fixture(kind);
    assert.deepEqual(await f.read([]), []);
    assert.equal(f.state.batches.length, 0);
    f.state.records.set('100', { id: '100', isPublic: '1' });
    assert.deepEqual((await f.read(Array.from({ length: 101 }, (_, i) => String(i)))).map(r => r.id), ['100']);
    assert.deepEqual(f.state.batches.map(keys => keys.length), [100, 1]);
  });
  test(`${kind}: lookup failure does not silently return a partial list`, async () => {
    const f = fixture(kind);
    f.state.fail = true;
    await assert.rejects(f.read(Array.from({ length: 101 }, (_, i) => String(i))), /Database failure/);
    f.state.incomplete = true;
    await assert.rejects(f.read(['one']), /Incomplete/);
  });
}

test('report candidate indexes still filter current visibility and owner', async () => {
  const f = fixture('report');
  f.state.records.set('a', { id: 'a', public: '1', creatorUid: '7' });
  f.state.records.set('b', { id: 'b', public: '0', creatorUid: '8' });
  assert.deepEqual((await f.api.listPublicReports()).map(r => r.id), ['a']);
  assert.deepEqual((await f.api.listReportsByUser('8')).map(r => r.id), ['b']);
});
test('service lists preserve private and stale-category filtering', async () => {
  const f = fixture('service');
  f.state.records.set('a', { id: 'a', isPublic: '1', category: 'one' });
  f.state.records.set('b', { id: 'b', isPublic: '0', category: 'two' });
  assert.deepEqual((await f.read(['a', 'b'])).map(r => r.id), ['a']);
  assert.deepEqual((await f.read(['a', 'b'], { includePrivate: true })).map(r => r.id), ['a', 'b']);
  assert.deepEqual((await f.api.listServicesByCategory('one', { includePrivate: true })).map(r => r.id), ['a']);
});
