'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(kind) {
  const objects = new Map();
  const sets = new Map();
  const strings = new Map();
  let count = 0;
  let failAt = 0;
  let after = false;
  let concurrent = () => {};
  const failure = new Error('simulated database failure');
  async function write(fn) {
    count += 1;
    if (count === failAt && !after) { concurrent(); throw failure; }
    fn();
    if (count === failAt && after) { concurrent(); throw failure; }
  }
  const db = {
    setObject: (key, value) => write(() => objects.set(key, { ...value })),
    getObject: async key => objects.get(key) || null,
    sortedSetAdd: (key, score, id) => write(() => {
      if (!sets.has(key)) sets.set(key, new Map());
      sets.get(key).set(id, score);
    }),
    sortedSetRemove: () => { throw new Error('Unexpected compensating removal'); },
    delete: () => { throw new Error('Unexpected compensating deletion'); },
    set: (key, value) => write(() => strings.set(key, value)),
    get: async key => strings.get(key),
    getSortedSetRevRange: async key => [...(sets.get(key)?.keys() || [])],
  };
  const file = path.join(__dirname, '../lib', kind === 'report' ? 'store.js' : 'services.js');
  const realRequire = createRequire(file);
  const module = { exports: {} };
  const localRequire = name => {
    if (name === './nodebb') return { db, groups: {} };
    if (name === './upload') return {};
    if (name === './config') return { getConfig: () => ({}) };
    return realRequire(name);
  };
  const extra = kind === 'report' ? 'module.exports.save = saveReport;' : 'module.exports.save = saveService;';
  vm.runInThisContext(`(function(require, module, exports) {\n${fs.readFileSync(file, 'utf8')}\n${extra}\n})`, { filename: file })(localRequire, module, module.exports);
  return { api: module.exports, objects, sets, strings, failure,
    fail(n, committed = false, race = () => {}) { count = 0; failAt = n; after = committed; concurrent = race; },
  };
}

for (const kind of ['report', 'service']) {
  const prefix = kind === 'report' ? 'havaintokartta:report:' : 'palvelukartta:service:';
  const initial = { id: 'one', creatorUid: '7', description: 'original', public: false,
    name: 'Original', slug: 'original', category: 'old', isPublic: true,
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' };
  const changed = { ...initial, description: 'edited', public: true, slug: 'edited', category: 'new' };
  // Three index operations followed by the authoritative object write.
  for (const existing of [false, true]) for (const after of [false, true]) for (let step = 1; step <= 4; step++) {
    test(`${kind}: ${existing ? 'update' : 'create'} failure ${after ? 'after' : 'before'} write ${step} preserves authoritative data`, async () => {
      const f = fixture(kind);
      if (existing) await f.api.save(initial);
      const previous = f.objects.get(prefix + initial.id);
      f.fail(step, after);
      await assert.rejects(f.api.save(changed), err => err === f.failure);
      if (step === 4 && after) {
        assert.equal(f.objects.get(prefix + initial.id).description, 'edited');
      } else {
        assert.deepEqual(f.objects.get(prefix + initial.id), previous);
      }
      // Index-only writes must not publish an old private report or resolve
      // an uncommitted category/slug, and failed creates must not be listed.
      if (!(step === 4 && after)) {
        if (kind === 'report') assert.deepEqual(await f.api.listPublicReports(), []);
        else {
          assert.equal(await f.api.getServiceBySlug('edited'), null);
          assert.deepEqual(await f.api.listServicesByCategory('new'), []);
          assert.deepEqual(await f.api.searchServices({ categories: ['new'] }), []);
          if (existing) assert.equal((await f.api.getServiceBySlug('original')).id, 'one');
        }
      }
      // Retrying converges the candidate indexes and record without a rollback.
      f.fail(0);
      await f.api.save(changed);
      assert.equal(f.objects.get(prefix + initial.id).description, 'edited');
      if (kind === 'report') assert.equal((await f.api.listPublicReports()).length, 1);
      else assert.equal((await f.api.getServiceBySlug('edited')).id, 'one');
    });
  }
  test(`${kind}: failed save never rolls back a concurrent writer`, async () => {
    const f = fixture(kind);
    await f.api.save(initial);
    f.fail(2, true, () => f.objects.set(prefix + initial.id, { ...f.objects.get(prefix + initial.id), description: 'concurrent' }));
    await assert.rejects(f.api.save(changed), err => err === f.failure);
    assert.equal(f.objects.get(prefix + initial.id).description, 'concurrent');
  });
}

test('unpublishing a report keeps it out of public results despite retained index membership', async () => {
  const f = fixture('report');
  await f.api.save({ id: 'one', creatorUid: '7', public: true });
  await f.api.save({ id: 'one', creatorUid: '7', public: false });
  assert.equal((await f.api.listAllReports()).length, 1);
  assert.deepEqual(await f.api.listPublicReports(), []);
  assert.deepEqual(await f.api.listReportsByUser('8'), []);
});

test('failed unpublish preserves the existing public record and lookup', async () => {
  const f = fixture('report');
  const report = { id: 'one', creatorUid: '7', public: true };
  await f.api.save(report);
  f.fail(3); // Two indexes, then the record write for a private report.
  await assert.rejects(f.api.save({ ...report, public: false }), err => err === f.failure);
  assert.equal((await f.api.listPublicReports()).length, 1);
});

test('candidate user index does not expose a report under an uncommitted owner', async () => {
  const f = fixture('report');
  const report = { id: 'one', creatorUid: '7', public: false };
  await f.api.save(report);
  f.fail(3);
  await assert.rejects(f.api.save({ ...report, creatorUid: '8' }), err => err === f.failure);
  assert.deepEqual(await f.api.listReportsByUser('8'), []);
  assert.equal((await f.api.listReportsByUser('7')).length, 1);
});

test('successful service changes filter old candidates and retain private-list access rules', async () => {
  const f = fixture('service');
  const service = { id: 'one', slug: 'old', category: 'old', isPublic: true };
  await f.api.save(service);
  await f.api.save({ ...service, slug: 'new', category: 'new', isPublic: false });
  assert.equal(await f.api.getServiceBySlug('old'), null);
  assert.deepEqual(await f.api.listServicesByCategory('old', { includePrivate: true }), []);
  assert.deepEqual(await f.api.listAllServices(), []);
  assert.deepEqual(await f.api.listServicesByCategory('new'), []);
  assert.equal((await f.api.listServicesByCategory('new', { includePrivate: true })).length, 1);
  assert.equal((await f.api.searchServices({ categories: ['new'], includePrivate: true })).length, 1);
});
