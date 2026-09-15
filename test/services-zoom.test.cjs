'use strict';

// Tests for services.js baseZoom bounds (create/update payloads + stored reads).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.NODEBB_API_KEY = 'test-api-key-0123456789abcdef';

// Stub nconf so lib/config.js resolves without a running NodeBB.
const originalLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === 'nconf') {
    return {
      get: (key) => {
        if (key === 'upload_path') return '/tmp/havaintokartta-services-test';
        if (key === 'upload_url') return '/assets/uploads';
        if (key === 'url') return 'https://forum.example';
        return undefined;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const objectStore = new Map();
const sortedSets = new Map();

const db = {
  get: async (key) => (objectStore.has(key) ? objectStore.get(key) : null),
  set: async (key, value) => { objectStore.set(key, value); },
  getObject: async (key) => (objectStore.has(key) ? objectStore.get(key) : null),
  setObject: async (key, value) => { objectStore.set(key, value); },
  delete: async (key) => { objectStore.delete(key); },
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
require.main.require = function stubbedMainRequire(id) {
  if (id === './src/database') return db;
  if (id === './src/groups') return { isMember: async () => true };
  if (id === './src/topics') return { post: async () => ({ tid: 1 }), reply: async () => {} };
  if (id === './src/user') return { getUserFields: async () => ({ username: 'testuser' }) };
  return originalMainRequire.call(this, id);
};

const services = require('../lib/services.js');

const GEOMETRY = { type: 'Point', coordinates: [24.53, 64.08] };

function createPayload(extra = {}) {
  return {
    name: 'Testikohde',
    category: 'luontopolku',
    geometry: GEOMETRY,
    ...extra,
  };
}

test.after(() => {
  require.main.require = originalMainRequire;
  Module._load = originalLoad;
});

test('rejects non-finite and out-of-range baseZoom on create', async () => {
  for (const baseZoom of [NaN, Infinity, -Infinity, -1, 999]) {
    const created = await services.createService(createPayload({ baseZoom }), '1');
    assert.equal(created.baseZoom, undefined, `baseZoom ${baseZoom} must be dropped`);
    assert.equal((await services.getService(created.id)).baseZoom, undefined);
  }
});

test('keeps valid fractional baseZoom through storage and update', async () => {
  const created = await services.createService(createPayload({ baseZoom: 13.5 }), '1');
  assert.equal(created.baseZoom, 13.5);

  const updated = await services.updateService(created.id, { baseZoom: 20 }, '1');
  assert.equal(updated.baseZoom, 20);
  assert.equal((await services.getService(created.id)).baseZoom, 20);

  const cleared = await services.updateService(created.id, { baseZoom: NaN }, '1');
  assert.equal(cleared.baseZoom, undefined);
  assert.equal((await services.getService(created.id)).baseZoom, undefined);
});

test('bounds baseZoom inside heittopaikat and korit entries', async () => {
  const created = await services.createService(createPayload({
    heittopaikat: [
      { type: 'Point', coordinates: [24.5, 64.0], baseZoom: 1e9 },
      { type: 'Point', coordinates: [24.5, 64.0], baseZoom: 12 },
    ],
    korit: [
      { type: 'Point', coordinates: [24.5, 64.0], baseZoom: -3 },
      { type: 'Point', coordinates: [24.5, 64.0], baseZoom: 14, color: 'blue' },
    ],
  }), '1');

  assert.deepEqual(created.heittopaikat.map((h) => h.baseZoom), [undefined, 12]);
  assert.deepEqual(created.korit.map((k) => k.baseZoom), [undefined, 14]);
});

test('drops corrupt legacy baseZoom values on read', async () => {
  const created = await services.createService(createPayload(), '1');
  const key = `palvelukartta:service:${created.id}`;
  const stored = objectStore.get(key);

  objectStore.set(key, { ...stored, baseZoom: 'Infinity' });
  assert.equal((await services.getService(created.id)).baseZoom, undefined);

  objectStore.set(key, { ...stored, baseZoom: '13.25' });
  assert.equal((await services.getService(created.id)).baseZoom, 13.25);
});
