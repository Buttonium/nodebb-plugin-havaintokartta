'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture() {
  const records = new Map();
  const indexes = new Map();
  const claims = new Map();
  let increments = 0;
  let listReads = 0;
  const db = {
    async incrObjectField(key, field) {
      increments++;
      const claimKey = `${key}:${field}`;
      const count = (claims.get(claimKey) || 0) + 1;
      claims.set(claimKey, count);
      return count;
    },
    async setObject(key, value) { indexes.set(key, value); },
    async getObject(key) { return indexes.get(key) || null; },
  };
  const store = {
    beforeSave: null,
    async listAllReports() { listReads++; return [...records.values()]; },
    async getReport(id) { return records.get(id) || null; },
    async saveReportSlug(report, slug) {
      if (store.beforeSave) { const hook = store.beforeSave; store.beforeSave = null; await hook(); }
      if (records.get(report.id) !== report) throw Object.assign(new Error('Conflict'), { status: 409 });
      const saved = { ...report, slug, revision: 'saved' };
      records.set(report.id, saved);
      return saved;
    },
  };
  const file = path.join(__dirname, '../lib/report-slugs.js');
  const actualRequire = createRequire(file);
  const localRequire = name => name === './nodebb' ? { db } : name === './store' ? store : actualRequire(name);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`, { filename: file })
    (localRequire, module, module.exports);
  return { api: module.exports, records, indexes, db, store, get listReads() { return listReads; },
    get increments() { return increments; } };
}

test('Finnish titles, punctuation, empty titles and ID-shaped titles produce usable slugs', () => {
  const { slugifyReportTitle } = fixture().api;
  assert.equal(slugifyReportTitle('Vaarallinen silta'), 'vaarallinen-silta');
  assert.equal(slugifyReportTitle('  Kävelytie: Öljyä & jäätä!  '), 'kavelytie-oljya-jaata');
  assert.equal(slugifyReportTitle('Silta/tie_este'), 'silta-tie-este');
  assert.equal(slugifyReportTitle('🎉?!'), 'ilmoitus');
  assert.equal(slugifyReportTitle(''), 'ilmoitus');
  assert.equal(slugifyReportTitle('123'), 'ilmoitus-123');
  assert.equal(slugifyReportTitle('ffbba940-d8a6-446d-9fdd-500b8264249c'), 'ilmoitus-ffbba940-d8a6-446d-9fdd-500b8264249c');
  assert.equal(slugifyReportTitle('a'.repeat(99) + ' - b').length, 99);
});

test('concurrent identical titles reserve distinct slugs, including suffix-shaped titles', async () => {
  const f = fixture();
  const slugs = await Promise.all(Array.from({ length: 10 }, (_, id) =>
    f.api.reserveReportSlug({ id: String(id), title: 'Vaarallinen silta' })));
  assert.equal(new Set(slugs).size, 10);
  assert.ok(slugs.includes('vaarallinen-silta'));
  assert.ok(slugs.includes('vaarallinen-silta-2'));
  assert.equal(await f.api.reserveReportSlug({ id: 'suffix', title: 'Vaarallinen silta 2' }), 'vaarallinen-silta-2-2');
});

test('many legacy reports without titles allocate suffixes with bounded work', async () => {
  const f = fixture();
  for (let i = 1; i <= 1100; i++) {
    assert.equal(await f.api.reserveReportSlug({ id: String(i), title: '' }), i === 1 ? 'ilmoitus' : `ilmoitus-${i}`);
  }
  assert.equal(f.increments, 2200);
});

test('backfill persists URLs once, in oldest-first order, and keeps them after title edits', async () => {
  const f = fixture();
  f.records.set('new', { id: 'new', title: 'Silta', createdAt: '2026-10-09' });
  f.records.set('old', { id: 'old', title: 'Silta', createdAt: '2026-10-01' });
  await Promise.all([f.api.ensureLegacyReportSlugs(), f.api.ensureLegacyReportSlugs()]);
  assert.equal(f.listReads, 1);
  assert.equal(f.records.get('old').slug, 'silta');
  assert.equal(f.records.get('new').slug, 'silta-2');
  f.records.set('old', { ...f.records.get('old'), title: 'Uusi otsikko' });
  assert.equal((await f.api.ensureReportSlug(f.records.get('old'))).slug, 'silta');
  assert.equal((await f.api.getReportBySlug('silta')).id, 'old');
});

test('a backfill conflict retains the winning slug and rejects the unused candidate', async () => {
  const f = fixture();
  const original = { id: 'one', title: 'Silta' };
  f.records.set('one', original);
  f.store.beforeSave = async () => {
    const slug = await f.api.reserveReportSlug(original);
    f.records.set('one', { ...original, slug, revision: 'winner' });
  };
  assert.equal((await f.api.ensureReportSlug(original)).slug, 'silta-2');
  assert.equal(await f.api.getReportBySlug('silta'), null);
  assert.equal((await f.api.getReportBySlug('silta-2')).id, 'one');
});

test('deleted and uncommitted slugs never resolve or get reused', async () => {
  const f = fixture();
  const report = { id: 'one', title: 'Silta' };
  const slug = await f.api.reserveReportSlug(report);
  assert.equal(await f.api.getReportBySlug(slug), null);
  f.records.set('one', { ...report, slug });
  assert.equal((await f.api.getReportBySlug(slug)).id, 'one');
  f.records.delete('one');
  assert.equal(await f.api.getReportBySlug(slug), null);
  assert.equal(await f.api.reserveReportSlug({ id: 'two', title: 'Silta' }), 'silta-2');
  assert.equal(await f.api.getReportBySlug('../silta'), null);
});

test('failed backfills allow reads, defer repeated attempts and can retry', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const warning = t.mock.method(console, 'warn', () => {});
  const f = fixture();
  f.records.set('one', { id: 'one', title: 'Silta' });
  f.store.beforeSave = () => { throw new Error('Database unavailable'); };
  await f.api.ensureLegacyReportSlugs();
  assert.equal(f.records.get('one').slug, undefined);
  assert.equal(warning.mock.callCount(), 1);
  await f.api.ensureLegacyReportSlugs();
  assert.equal(f.listReads, 1);
  now += 30_001;
  await f.api.ensureLegacyReportSlugs();
  assert.equal(f.records.get('one').slug, 'silta-2');
  assert.equal(f.listReads, 2);
});

test('a report created without a slug requests another backfill after a completed migration', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  await f.api.ensureLegacyReportSlugs();
  f.records.set('late', { id: 'late', title: 'Uusi silta' });
  f.api.deferReportSlugBackfill();
  await f.api.ensureLegacyReportSlugs();
  assert.equal(f.records.get('late').slug, undefined);
  now += 30_001;
  await f.api.ensureLegacyReportSlugs();
  assert.equal(f.records.get('late').slug, 'uusi-silta');
});
