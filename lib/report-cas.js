'use strict';

const errors = require('./errors');

// NodeBB 4.15.2 PostgreSQL legacy_hash/legacy_zset storage. Keep all queries on
// one checked-out connection: ordinary db methods start separate transactions.
async function saveReportIfUnchanged(db, key, data, expected, indexes, score) {
  if (typeof db.pool?.connect !== 'function') {
    throw errors.serviceUnavailable('Atomic report updates require the PostgreSQL database adapter.');
  }
  const client = await db.pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await client.query(`
      UPDATE "legacy_hash" AS h SET "data" = h."data" || $2::jsonb
      WHERE h."_key" = $1
        AND COALESCE(h."data"->>'revision', '') = $3
        AND COALESCE(h."data"->>'stage', '') = $4
        AND COALESCE(h."data"->>'updatedAt', '') = $5
        AND EXISTS (SELECT 1 FROM "legacy_object_live" o
                    WHERE o."_key" = h."_key" AND o."type" = 'hash')
      RETURNING h."_key"`, [key, JSON.stringify(data), expected.revision,
      expected.stage, expected.updatedAt]);
    if (result.rows.length !== 1) {
      throw errors.conflict('Report changed during update. Reload and try again.');
    }
    for (const index of indexes) {
      const type = await client.query(`
        INSERT INTO "legacy_object" ("_key", "type") VALUES ($1, 'zset')
        ON CONFLICT ("_key") DO UPDATE SET "type" = "legacy_object"."type"
        RETURNING "type"`, [index]);
      if (type.rows[0]?.type !== 'zset') throw new Error('Invalid report index type');
      await client.query(`
        INSERT INTO "legacy_zset" ("_key", "value", "score") VALUES ($1, $2, $3)
        ON CONFLICT ("_key", "value") DO UPDATE SET "score" = EXCLUDED."score"`,
      [index, data.id, score]);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
    throw err;
  } finally {
    client.release(releaseError);
    // NodeBB's hash cache is shared through its invalidation API. Invalidate
    // even after an ambiguous COMMIT response; never retain the old snapshot.
    db.objectCache?.del(key);
  }
}

module.exports = { saveReportIfUnchanged };
