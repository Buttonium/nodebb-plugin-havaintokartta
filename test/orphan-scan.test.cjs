'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-scan-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { ylivieskahubUrl: 'https://hub.invalid', apiKey: 'test' };
  const namespaces = { havaintokartta: 'uploads', palvelukartta: 'serviceUploads',
    'ylivieskahub-news': 'newsUploads', 'ylivieskahub-events': 'eventUploads' };
  for (const [app, key] of Object.entries(namespaces)) {
    config[key + 'Directory'] = path.join(root, app);
    config[key + 'UrlPrefix'] = '/uploads/' + app;
    await fs.mkdir(config[key + 'Directory']);
  }
  const state = { reports: [], services: [], newsImages: [], eventImages: [],
    beforeLookup: async () => {}, invalidated: new Set(), fail: false };
  const db = {
    objectCache: { del(keys) { keys.forEach(key => state.invalidated.add(key)); } },
    async getSortedSetRevRange(key) {
      await state.beforeLookup(key);
      if (state.fail) throw new Error('Database unavailable');
      return (key.startsWith('havaintokartta') ? state.reports : state.services).map((_, i) => String(i));
    },
    async getObjects(keys) {
      for (const key of keys) assert.ok(state.invalidated.delete(key), 'must invalidate before reading');
      return keys.map(key => (key.startsWith('havaintokartta') ? state.reports : state.services)[Number(key.split(':').pop())]);
    },
  };
  const file = path.join(__dirname, '../lib/orphan-scan.js');
  const realRequire = createRequire(file);
  const module = { exports: {} };
  const localRequire = name => name === './nodebb' ? { db } :
    name === './config' ? { getConfig: () => config } : realRequire(name);
  const fetch = async () => {
    if (state.fetchError) throw new Error('Timeout');
    return { ok: !state.httpError, status: 503,
      json: async () => state.response || { newsImages: state.newsImages, eventImages: state.eventImages } };
  };
  vm.runInThisContext(`(function(require,module,exports,fetch){${syncFs.readFileSync(file, 'utf8')}\n})`, { filename: file })(localRequire, module, module.exports, fetch);
  return { ...module.exports, state, config,
    url(app, name) { return 'https://forum.invalid' + config[namespaces[app] + 'UrlPrefix'] + '/' + name; },
    async file(app, name, age = 48) {
      const file = path.join(config[namespaces[app] + 'Directory'], name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'test image');
      const date = new Date(Date.now() - age * 3600000);
      await fs.utimes(file, date, date);
      return file;
    },
  };
}

test('recent/future uploads are hidden and protected; old orphan is deleted with accurate results', async t => {
  const f = await fixture(t);
  await f.file('havaintokartta', 'old.jpg');
  for (const [name, age] of [['new.jpg', 0], ['future.jpg', -1]]) await f.file('havaintokartta', name, age);
  assert.deepEqual((await f.scanOrphans()).havaintokartta.orphans.map(o => o.path), ['old.jpg']);
  const result = await f.deleteOrphans('havaintokartta', ['old.jpg', 'new.jpg', 'future.jpg', '../outside.jpg']);
  assert.deepEqual([result.deleted, result.skipped, result.failed], [1, 2, 1]);
  assert.deepEqual(result.deletedPaths, ['old.jpg']);
});

for (const app of ['havaintokartta', 'palvelukartta', 'ylivieskahub-news', 'ylivieskahub-events']) {
  test(`${app}: stale scan selection cannot delete a subsequently referenced URL alias`, async t => {
    const f = await fixture(t);
    const file = await f.file(app, 'shared.jpg');
    assert.equal((await f.scanOrphans()).grandTotal.count, 1);
    const url = f.url(app, 'shared.jpg') + '?download=1#image';
    if (app === 'havaintokartta') f.state.reports = [{ images: JSON.stringify([url]), stage: 'draft' }];
    else if (app === 'palvelukartta') f.state.services = [{ images: JSON.stringify([{ url }]), isPublic: false }];
    else f.state.eventImages = [url]; // Includes event -> news namespace reuse.
    assert.equal((await f.deleteOrphans(app, ['shared.jpg'])).skipped, 1);
    await fs.access(file);
    assert.equal((await f.scanOrphans()).grandTotal.count, 0);
  });
}

test('each batch item gets fresh references, including cross-namespace service references', async t => {
  const f = await fixture(t);
  await f.file('havaintokartta', 'first.jpg');
  const second = await f.file('havaintokartta', 'second.jpg');
  let reads = 0;
  f.state.beforeLookup = async key => {
    if (key.startsWith('havaintokartta') && ++reads === 2) {
      f.state.services = [{ images: JSON.stringify([f.url('havaintokartta', 'second.jpg')]) }];
    }
  };
  const result = await f.deleteOrphans('havaintokartta', ['first.jpg', 'second.jpg']);
  assert.deepEqual([result.deleted, result.skipped], [1, 1]);
  await fs.access(second);
});

for (const failure of ['db', 'report-json', 'service-json', 'hub-shape', 'hub-http', 'hub-timeout']) {
  test(`${failure}: uncertain references preserve selected file`, async t => {
    const f = await fixture(t);
    const file = await f.file('ylivieskahub-news', 'orphan.jpg');
    if (failure === 'db') f.state.fail = true;
    if (failure === 'report-json') f.state.reports = [{ images: '[broken' }];
    if (failure === 'service-json') f.state.services = [{ images: '{broken' }];
    if (failure === 'hub-shape') f.state.response = { newsImages: [] };
    if (failure === 'hub-http') f.state.httpError = true;
    if (failure === 'hub-timeout') f.state.fetchError = true;
    const result = await f.deleteOrphans('ylivieskahub-news', ['orphan.jpg']);
    assert.equal(result.failed, 1);
    assert.equal(result.deleted, 0);
    await fs.access(file);
  });
}

test('file refreshed during reference lookup survives the second age check', async t => {
  const f = await fixture(t);
  const file = await f.file('havaintokartta', 'old.jpg');
  f.state.beforeLookup = async () => { const now = new Date(); await fs.utimes(file, now, now); };
  assert.equal((await f.deleteOrphans('havaintokartta', ['old.jpg'])).skipped, 1);
  await fs.access(file);
});

test('legacy report references beyond the display limit remain protected', async t => {
  const f = await fixture(t);
  await f.file('havaintokartta', 'sixth.jpg');
  f.state.reports = [{ images: JSON.stringify([...Array(5)].map((_, i) => f.url('havaintokartta', i + '.jpg')).concat(f.url('havaintokartta', 'sixth.jpg'))) }];
  assert.equal((await f.deleteOrphans('havaintokartta', ['sixth.jpg'])).skipped, 1);
});

for (const app of ['havaintokartta', 'palvelukartta', 'ylivieskahub-news', 'ylivieskahub-events']) {
  test(`${app}: encoded URL references survive scan and direct deletion`, async t => {
    const f = await fixture(t);
    const cases = [
      ['shared.jpg', '%73hared.jpg'],
      ['date/kuva ä.jpg', 'date%2Fkuva%20%C3%A4.jpg'],
      ['literal%73.jpg', 'literal%2573.jpg'],
    ];
    for (const [name] of cases) await f.file(app, name);
    const urls = cases.map(([, encoded]) => f.url(app, encoded) + '?download=1#preview');
    if (app === 'havaintokartta') f.state.reports = [{ images: JSON.stringify(urls) }];
    else if (app === 'palvelukartta') f.state.services = [{ images: JSON.stringify(urls.map(url => ({ url }))) }];
    else f.state.newsImages = urls;
    assert.equal((await f.scanOrphans()).grandTotal.count, 0);
    const result = await f.deleteOrphans(app, cases.map(([name]) => name));
    assert.deepEqual([result.deleted, result.skipped, result.failed], [0, 3, 0]);
    for (const [name] of cases) await fs.access(path.join(
      app === 'havaintokartta' ? f.config.uploadsDirectory :
        app === 'palvelukartta' ? f.config.serviceUploadsDirectory :
          app === 'ylivieskahub-news' ? f.config.newsUploadsDirectory : f.config.eventUploadsDirectory, name));
  });
}

test('URL decoding happens exactly once; unrelated file remains eligible', async t => {
  const f = await fixture(t);
  await f.file('havaintokartta', 'literal%73.jpg');
  await f.file('havaintokartta', 'literals.jpg');
  f.state.reports = [{ images: JSON.stringify([f.url('havaintokartta', 'literal%2573.jpg')]) }];
  assert.deepEqual((await f.scanOrphans()).havaintokartta.orphans.map(o => o.path), ['literals.jpg']);
});

test('nested empty directories have correct paths and can be removed without deleting used parents', async t => {
  const f = await fixture(t);
  const base = f.config.uploadsDirectory;
  await fs.mkdir(path.join(base, 'date', 'empty', 'leaf'), { recursive: true });
  await fs.writeFile(path.join(base, 'date', 'used.jpg'), 'used');
  const result = await f.scanOrphans();
  assert.deepEqual(result.havaintokartta.emptyDirs, ['date/empty/leaf', 'date/empty']);
  const deletion = await f.deleteEmptyDirectories('havaintokartta', [...result.havaintokartta.emptyDirs].reverse());
  assert.deepEqual([deletion.deleted, deletion.failed], [2, 0]);
  assert.deepEqual(deletion.deletedPaths, ['date/empty/leaf', 'date/empty']);
  await fs.access(path.join(base, 'date', 'used.jpg'));
});

test('hub empty directory paths include source and remove the whole empty tree', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.config.newsUploadsDirectory, 'date', 'leaf'), { recursive: true });
  const result = await f.scanOrphans();
  assert.deepEqual(result.ylivieskahub.emptyDirs, ['news/date/leaf', 'news/date']);
  const deletion = await f.deleteEmptyDirectories('ylivieskahub', result.ylivieskahub.emptyDirs);
  assert.equal(deletion.deleted, 2);
  assert.equal(deletion.failed, 0);
  await fs.access(f.config.newsUploadsDirectory);
});

test('hidden files and files created after scanning survive empty directory cleanup', async t => {
  const f = await fixture(t);
  const base = f.config.uploadsDirectory;
  await fs.mkdir(path.join(base, 'hidden'));
  await fs.writeFile(path.join(base, 'hidden', '.keep'), 'keep');
  await fs.mkdir(path.join(base, 'empty'));
  const result = await f.scanOrphans();
  assert.deepEqual(result.havaintokartta.emptyDirs, ['empty']);
  await fs.writeFile(path.join(base, 'empty', 'new.jpg'), 'new upload');
  const deletion = await f.deleteEmptyDirectories('havaintokartta', ['empty']);
  assert.deepEqual([deletion.deleted, deletion.failed, deletion.deletedPaths.length], [0, 1, 0]);
  await fs.access(path.join(base, 'empty', 'new.jpg'));
  await fs.access(path.join(base, 'hidden', '.keep'));
});
