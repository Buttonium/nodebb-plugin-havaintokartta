'use strict';

// Tests for lib/reports.js updateReport (POST /reports/:id/update).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

process.env.NODEBB_API_KEY = 'test-api-key-0123456789abcdef';
process.env.NODEBB_HAVAINTOKARTTA_CATEGORY_ID = '7';

// Temp uploads dir so image deletion assertions never touch real data.
const tmpUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'havaintokartta-update-test-'));

// Stub nconf so lib/config.js resolves uploads into the temp dir.
const originalLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === 'nconf') {
    return {
      get: (key) => {
        if (key === 'upload_path') return tmpUploads;
        if (key === 'upload_url') return '/assets/uploads';
        if (key === 'url') return 'https://forum.example';
        return undefined;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Stub NodeBB internals (require.main.require calls inside lib/nodebb.js).
const objectStore = new Map();
const sortedSets = new Map();

const db = {
  pool: require('./__mocks__/report-pool.cjs')(objectStore, sortedSets),
  getObject: async (key) => (objectStore.has(key) ? objectStore.get(key) : null),
  setObject: async (key, value) => {
    objectStore.set(key, value);
  },
  delete: async (key) => {
    objectStore.delete(key);
  },
  sortedSetAdd: async (key, score, member) => {
    if (!sortedSets.has(key)) sortedSets.set(key, new Map());
    sortedSets.get(key).set(member, score);
  },
  sortedSetRemove: async (key, member) => {
    if (sortedSets.has(key)) sortedSets.get(key).delete(member);
  },
  getSortedSetRevRange: async (key) => Array.from((sortedSets.get(key) || new Map()).keys()),
};

const originalMainRequire = require.main.require;
let replyCount = 0;
let topicCount = 0;
require.main.require = function stubbedMainRequire(id) {
  if (id === './src/database') return db;
  if (id === './src/groups') return { isMember: async () => true };
  if (id === './src/topics') return {
    post: async () => ({ tid: ++topicCount, slug: 'test-topic' }),
    reply: async () => { replyCount++; },
  };
  if (id === './src/user') return { getUserFields: async () => ({ username: 'testuser' }) };
  return originalMainRequire.call(this, id);
};

const reports = require('../lib/reports.js');
const store = require('../lib/store.js');

const PREFIX = '/assets/uploads/files/reports';
const IMG1 = `${PREFIX}/2026-09-01/one.jpg`;
const IMG2 = `${PREFIX}/2026-09-01/two.jpg`;
const NEW_IMG = `${PREFIX}/2026-09-07/three.jpg`;
const NEW_IMG_ABSOLUTE = 'https://forum.example/assets/uploads/files/reports/2026-09-07/three.jpg';

async function makeReport({ creatorUid = '1', stage = 1, images = null } = {}) {
  const created = await reports.createReport({
    creatorUid,
    citySlug: 'ylivieska',
    lat: 64.08,
    lng: 24.53,
    description: 'Alkuperäinen kuvaus',
    images: images ? JSON.stringify(images) : null,
  });
  if (stage !== 1) {
    await store.saveReport({ ...created, stage });
  }
  return store.getReport(created.id);
}

test('rejects updates by non-creators with 403', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });
  await assert.rejects(
    () => reports.updateReport(report.id, { actorUid: '2', description: 'Uusi kuvaus' }),
    (err) => err.status === 403
  );
});

test('rejects updates for stage 2 (reviewed) reports with 409', async () => {
  const report = await makeReport({ creatorUid: '1', stage: 2, images: [IMG1] });
  await assert.rejects(
    () => reports.updateReport(report.id, { actorUid: '1', description: 'Uusi kuvaus' }),
    (err) => err.status === 409
  );
});

test('rejects missing actorUid with 400', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });
  await assert.rejects(
    () => reports.updateReport(report.id, { description: 'Uusi kuvaus' }),
    (err) => err.status === 400
  );
});

test('updates description and keeps images for the creator', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });
  const updated = await reports.updateReport(report.id, { actorUid: '1', description: 'Päivitettykuvaus' });

  assert.equal(updated.description, 'Päivitettykuvaus');
  assert.equal(updated.stage, 1);
  assert.deepEqual(JSON.parse(updated.images), [IMG1]);
  assert.ok(updated.updatedAt >= report.updatedAt);
});

test('replaces images and deletes removed image files from disk', async () => {
  const img1Path = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'one.jpg');
  const img2Path = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'two.jpg');
  fs.mkdirSync(path.dirname(img2Path), { recursive: true });
  fs.writeFileSync(img1Path, 'img1');
  fs.writeFileSync(img2Path, 'img2');

  const report = await makeReport({ creatorUid: '1', images: [IMG1, IMG2] });
  const updated = await reports.updateReport(report.id, { actorUid: '1', images: [IMG1] });

  assert.deepEqual(JSON.parse(updated.images), [IMG1]);
  assert.throws(() => fs.accessSync(img2Path));
  fs.accessSync(img1Path);
});

test('accepts newly uploaded paths under the reports prefix (relative and absolute)', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });

  const relative = await reports.updateReport(report.id, { actorUid: '1', images: [IMG1, NEW_IMG] });
  assert.deepEqual(JSON.parse(relative.images), [IMG1, NEW_IMG]);

  const absolute = await reports.updateReport(report.id, {
    actorUid: '1',
    images: [IMG1, NEW_IMG, NEW_IMG_ABSOLUTE],
  });
    // Both forms are stored as sent; both pass the prefix check.
    assert.equal(JSON.parse(absolute.images).length, 3);
});

test('rejects image lists containing foreign URLs with 400', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });

  await assert.rejects(
    () => reports.updateReport(report.id, { actorUid: '1', images: [IMG1, 'https://evil.example/steal.jpg'] }),
    (err) => err.status === 400
  );

  // A path under another plugin uploads prefix must also be rejected.
  await assert.rejects(
    () => reports.updateReport(report.id, { actorUid: '1', images: ['/assets/uploads/files/news/2026-09-01/x.jpg'] }),
    (err) => err.status === 400
  );
});

test('rejects empty image lists with 400', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });
  await assert.rejects(
    () => reports.updateReport(report.id, { actorUid: '1', images: [] }),
    (err) => err.status === 400
  );
});

test('rejects more than five images with 400', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1] });
  const sixImages = [
    IMG1,
    NEW_IMG,
    `${PREFIX}/2026-09-07/a.jpg`,
    `${PREFIX}/2026-09-07/b.jpg`,
    `${PREFIX}/2026-09-07/c.jpg`,
    `${PREFIX}/2026-09-07/d.jpg`,
  ];
  await assert.rejects(
    () => reports.updateReport(report.id, { actorUid: '1', images: sixImages }),
    (err) => err.status === 400
  );
});

test('ignores kept-image input that omits description (images only update)', async () => {
  const report = await makeReport({ creatorUid: '1', images: [IMG1, IMG2] });
  const updated = await reports.updateReport(report.id, { actorUid: '1', images: [IMG2] });

  assert.equal(updated.description, 'Alkuperäinen kuvaus');
  assert.deepEqual(JSON.parse(updated.images), [IMG2]);
});

test('aborts with 409 and preserves the newer state when the report changes during update', async () => {
  // A concurrent review landing between the two reads must 409, not clobber.
  const racedImgPath = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'raced.jpg');
  fs.mkdirSync(path.dirname(racedImgPath), { recursive: true });
  fs.writeFileSync(racedImgPath, 'raced');
  const RACED_IMG = `${PREFIX}/2026-09-01/raced.jpg`;
  const report = await makeReport({ creatorUid: '1', images: [RACED_IMG] });

  const originalGetReport = store.getReport;
  let getReportCalls = 0;
  store.getReport = async (id) => {
    getReportCalls += 1;
    // Second read (pre-save gate): simulate a concurrent review write.
    if (getReportCalls === 2) {
      const current = await originalGetReport(id);
      await store.saveReport({
        ...current,
        stage: 2,
        public: true,
        tid: 4242,
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    return originalGetReport(id);
  };

  try {
    await assert.rejects(
      () => reports.updateReport(report.id, { actorUid: '1', description: 'Raced description' }),
      (err) => err.status === 409
    );
  } finally {
    store.getReport = originalGetReport;
  }

  // The review record must be intact.
  const after = await originalGetReport(report.id);
  assert.equal(after.stage, 2);
  assert.equal(after.tid, 4242);
  assert.equal(after.description, 'Alkuperäinen kuvaus');
  fs.accessSync(racedImgPath);
});

test('does not delete removed image files when saving the update fails', async () => {
  const keep1Path = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'savefail1.jpg');
  const keep2Path = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'savefail2.jpg');
  fs.mkdirSync(path.dirname(keep1Path), { recursive: true });
  fs.writeFileSync(keep1Path, 'keep1');
  fs.writeFileSync(keep2Path, 'keep2');
  const SAVEFAIL_IMG1 = `${PREFIX}/2026-09-01/savefail1.jpg`;
  const SAVEFAIL_IMG2 = `${PREFIX}/2026-09-01/savefail2.jpg`;
  const report = await makeReport({ creatorUid: '1', images: [SAVEFAIL_IMG1, SAVEFAIL_IMG2] });

  const originalSaveReport = store.saveReport;
  store.saveReport = async () => {
    throw new Error('simulated db failure');
  };

  try {
    await assert.rejects(
      () => reports.updateReport(report.id, { actorUid: '1', images: [SAVEFAIL_IMG1] }),
      (err) => /simulated db failure/.test(err.message)
    );
  } finally {
    store.saveReport = originalSaveReport;
  }

  // saveReport failed — both files must still exist.
  fs.accessSync(keep1Path);
  fs.accessSync(keep2Path);
  const after = await store.getReport(report.id);
  assert.deepEqual(JSON.parse(after.images), [SAVEFAIL_IMG1, SAVEFAIL_IMG2]);
});

test('review landing after the last read is not overwritten and removed images survive', async () => {
  const file = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'atomic.jpg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'keep');
  const image = `${PREFIX}/2026-09-01/atomic.jpg`;
  const report = await makeReport({ images: [image, IMG2] });
  db.pool.beforeUpdate = async () => {
    const current = await store.getReport(report.id);
    await store.saveReport({ ...current, stage: 2, public: true, tid: 42 }, current);
  };
  await assert.rejects(reports.updateReport(report.id, { actorUid: '1', images: [IMG2] }), err => err.status === 409);
  const saved = await store.getReport(report.id);
  assert.equal(saved.stage, 2);
  assert.equal(saved.tid, 42);
  assert.deepEqual(JSON.parse(saved.images), [image, IMG2]);
  fs.accessSync(file);
});

test('same-millisecond saves conflict through revision rather than timestamps', async () => {
  const report = await makeReport();
  const winner = await store.saveReport({ ...report, description: 'winner' }, report);
  assert.equal(winner.updatedAt, report.updatedAt);
  await assert.rejects(store.saveReport({ ...report, description: 'loser' }, report), err => err.status === 409);
  assert.equal((await store.getReport(report.id)).description, 'winner');
});

test('a concurrent edit wins against a stale review without deleting images or posting a reply', async () => {
  const image = `${PREFIX}/2026-09-01/review-conflict.jpg`;
  const file = path.join(tmpUploads, 'files', 'reports', '2026-09-01', 'review-conflict.jpg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'keep');
  const report = await makeReport({ images: [image] });
  await store.saveReport({ ...report, tid: 42 }, report);
  db.pool.beforeUpdate = async () => {
    const current = await store.getReport(report.id);
    await store.saveReport({ ...current, description: 'newer edit' }, current);
  };
  const before = replyCount;
  await assert.rejects(reports.reviewReport(report.id, { actorUid: '2', publishImage: false }), err => err.status === 409);
  const saved = await store.getReport(report.id);
  assert.equal(saved.stage, 1);
  assert.equal(saved.description, 'newer edit');
  assert.equal(replyCount, before);
  fs.accessSync(file);
});

test('review uses the revision returned by topic-link persistence and completion uses CAS', async () => {
  const report = await makeReport();
  const before = replyCount;
  const reviewed = await reports.reviewReport(report.id, { actorUid: '2', publishImage: true });
  assert.equal(reviewed.stage, 2);
  assert.ok(reviewed.tid);
  assert.ok(reviewed.revision);
  assert.equal(replyCount, before + 1);
  const done = await reports.markReportDone(report.id, { actorUid: '2', doneComment: 'done' });
  assert.equal(done.stage, 3);
  assert.notEqual(done.revision, reviewed.revision);
  await assert.rejects(reports.markReportDone(report.id, { actorUid: '2' }), err => err.status === 409);
  assert.equal(replyCount, before + 2);
});

test('stale completion cannot overwrite another completion or duplicate its reply', async () => {
  const report = await makeReport({ stage: 2 });
  db.pool.beforeUpdate = async () => {
    const current = await store.getReport(report.id);
    await store.saveReport({ ...current, stage: 3, doneComment: 'winner' }, current);
  };
  const before = replyCount;
  await assert.rejects(reports.markReportDone(report.id, { actorUid: '2' }), err => err.status === 409);
  assert.equal((await store.getReport(report.id)).doneComment, 'winner');
  assert.equal(replyCount, before);
});

test.after((t) => {
  require.main.require = originalMainRequire;
  Module._load = originalLoad;
  fs.rmSync(tmpUploads, { recursive: true, force: true });
});
