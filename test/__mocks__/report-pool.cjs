'use strict';

// Transaction model for controller tests. The optional PostgreSQL integration
// suite executes the real SQL separately; this adapter is not SQL validation.
module.exports = function reportPool(objects, indexes) {
  const pool = { beforeUpdate: null };
  pool.connect = async () => {
    let originalObjects;
    let originalIndexes;
    return {
      release() {},
      async query(sql, values = []) {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.startsWith('SET LOCAL')) return { rows: [] };
        if (sql.includes('UPDATE "legacy_hash"')) {
          if (pool.beforeUpdate) { const hook = pool.beforeUpdate; pool.beforeUpdate = null; await hook(); }
          originalObjects = new Map(objects);
          originalIndexes = new Map([...indexes].map(([k, v]) => [k, new Map(v)]));
          const [key, json, revision, stage, updatedAt] = values;
          const current = objects.get(key);
          if (!current || (current.revision || '') !== revision || current.stage !== stage || (current.updatedAt || '') !== updatedAt) return { rows: [] };
          objects.set(key, { ...current, ...JSON.parse(json) });
          return { rows: [{ _key: key }] };
        }
        if (sql.includes('INSERT INTO "legacy_object"')) return { rows: [{ type: 'zset' }] };
        if (sql.includes('INSERT INTO "legacy_zset"')) {
          const [key, id, score] = values;
          if (!indexes.has(key)) indexes.set(key, new Map());
          indexes.get(key).set(id, score);
          return { rows: [] };
        }
        if (sql === 'ROLLBACK' && originalObjects) {
          objects.clear(); for (const [k, v] of originalObjects) objects.set(k, v);
          indexes.clear(); for (const [k, v] of originalIndexes) indexes.set(k, v);
        } else if (sql !== 'COMMIT' && sql !== 'ROLLBACK') throw new Error(`Unexpected SQL: ${sql}`);
        return { rows: [] };
      },
    };
  };
  return pool;
};
