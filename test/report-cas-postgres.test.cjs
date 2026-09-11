'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { saveReportIfUnchanged } = require('../lib/report-cas');

// Set HAVAINTOKARTTA_TEST_PGLITE to an installed @electric-sql/pglite module
// path to run real PostgreSQL SQL without a production database connection.
test('PostgreSQL report CAS: conflicts, transactional indexes and rollback', {
  skip: !process.env.HAVAINTOKARTTA_TEST_PGLITE,
}, async () => {
  const { PGlite } = require(process.env.HAVAINTOKARTTA_TEST_PGLITE);
  const pg = new PGlite();
  await pg.exec(`
    CREATE TYPE legacy_object_type AS ENUM ('hash','zset');
    CREATE TABLE legacy_object (_key TEXT PRIMARY KEY, type legacy_object_type NOT NULL,
      "expireAt" timestamptz, UNIQUE (_key,type));
    CREATE TABLE legacy_hash (_key TEXT PRIMARY KEY, data jsonb NOT NULL,
      type legacy_object_type NOT NULL DEFAULT 'hash',
      FOREIGN KEY (_key,type) REFERENCES legacy_object(_key,type) ON DELETE CASCADE);
    CREATE TABLE legacy_zset (_key TEXT NOT NULL, value TEXT NOT NULL, score NUMERIC NOT NULL,
      type legacy_object_type NOT NULL DEFAULT 'zset', PRIMARY KEY (_key,value),
      FOREIGN KEY (_key,type) REFERENCES legacy_object(_key,type) ON DELETE CASCADE);
    CREATE VIEW legacy_object_live AS SELECT _key,type FROM legacy_object
      WHERE "expireAt" IS NULL OR "expireAt" > CURRENT_TIMESTAMP;
  `);
  let released = 0;
  const invalidated = [];
  let failIndex = false;
  const db = { objectCache: { del: key => invalidated.push(key) }, pool: { connect: async () => ({
    release() { released++; },
    query(sql, values) {
      if (failIndex && sql.includes('INSERT INTO "legacy_zset"')) throw new Error('index failure');
      return pg.query(sql, values);
    },
  }) } };
  const key = 'havaintokartta:report:one';
  const original = { id: 'one', stage: '1', updatedAt: 'same-time', description: 'original' };
  const snapshot = { ...original, revision: '' }; // pre-migration record
  await pg.query('INSERT INTO legacy_object (_key,type) VALUES ($1,\'hash\')', [key]);
  await pg.query('INSERT INTO legacy_hash (_key,data) VALUES ($1,$2)', [key, JSON.stringify(original)]);
  const read = async () => (await pg.query('SELECT data FROM legacy_hash WHERE _key=$1', [key])).rows[0]?.data;
  try {
    const approved = { ...original, stage: '2', revision: 'review', description: 'approved' };
    await saveReportIfUnchanged(db, key, approved, snapshot, ['all', 'public'], 1);
    await assert.rejects(saveReportIfUnchanged(db, key,
      { ...original, revision: 'edit' }, snapshot, ['loser-index'], 2), err => err.status === 409);
    assert.deepEqual(await read(), approved);
    assert.equal((await pg.query("SELECT * FROM legacy_object WHERE _key='loser-index'")).rows.length, 0);
    const edited = { ...approved, revision: 'next' };
    failIndex = true;
    await assert.rejects(saveReportIfUnchanged(db, key, edited, approved, ['new-index'], 3), /index failure/);
    assert.deepEqual(await read(), approved);
    assert.equal((await pg.query("SELECT * FROM legacy_object WHERE _key='new-index'")).rows.length, 0);
    failIndex = false;
    await saveReportIfUnchanged(db, key, edited, approved, ['all'], 4);
    assert.deepEqual(await read(), edited);
    assert.equal((await pg.query("SELECT score FROM legacy_zset WHERE _key='all'")).rows[0].score, '4');
    await pg.query('DELETE FROM legacy_object WHERE _key=$1', [key]);
    await assert.rejects(saveReportIfUnchanged(db, key, approved, edited, ['all'], 5), err => err.status === 409);
    assert.equal(await read(), undefined); // Never resurrect a deleted report.
    assert.equal(released, 5);
    assert.deepEqual(invalidated, Array(5).fill(key));
  } finally { await pg.close(); }
});

test('unsupported database adapter denies atomic mutations instead of blind writes', async () => {
  await assert.rejects(saveReportIfUnchanged({}, 'key', {}, {}, [], 0), err => err.status === 503);
});
