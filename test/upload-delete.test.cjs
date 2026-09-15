'use strict';

// Tests for upload.js deleteImage namespace boundary + traversal guards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-delete-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const config = {
    uploadsDirectory: path.join(root, 'reports'),
    uploadsUrlPrefix: '/assets/uploads/files/reports',
  };
  await fs.mkdir(config.uploadsDirectory, { recursive: true });

  const file = path.join(__dirname, '../lib/upload.js');
  const realRequire = createRequire(file);
  const module = { exports: {} };
  const localRequire = (name) => (name === './config' ? { getConfig: () => config } : realRequire(name));
  const source = await fs.readFile(file, 'utf8');

  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(
    localRequire,
    module,
    module.exports
  );

  return { ...module.exports, config, root };
}

async function writeImage(dir, relativePath) {
  const target = path.join(dir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'img');
  return target;
}

test('deletes files for canonical relative and absolute upload URLs', async (t) => {
  const f = await fixture(t);
  const relative = await writeImage(f.config.uploadsDirectory, '2026-09-15/one.jpg');
  const absolute = await writeImage(f.config.uploadsDirectory, '2026-09-15/two.jpg');

  assert.equal(await f.deleteReportImage('/assets/uploads/files/reports/2026-09-15/one.jpg'), true);
  await assert.rejects(fs.access(relative));

  assert.equal(
    await f.deleteReportImage('https://forum.example/assets/uploads/files/reports/2026-09-15/two.jpg'),
    true
  );
  await assert.rejects(fs.access(absolute));

  // The namespace root is not a file.
  assert.equal(await f.deleteReportImage('/assets/uploads/files/reports'), false);
});

test('rejects look-alike prefixes instead of aliasing files inside the namespace', async (t) => {
  const f = await fixture(t);
  // `reports-extra` is a different namespace that merely shares the prefix text.
  const sibling = await writeImage(path.join(f.root, 'reports-extra'), '2026-09-15/keep.jpg');
  const aliasTarget = await writeImage(f.config.uploadsDirectory, '-extra/2026-09-15/keep.jpg');

  assert.equal(
    await f.deleteReportImage('/assets/uploads/files/reports-extra/2026-09-15/keep.jpg'),
    false
  );
  await fs.access(sibling);
  await fs.access(aliasTarget);

  // Path traversal segments are rejected before any filesystem mapping.
  const outside = await writeImage(f.root, 'secret.jpg');
  assert.equal(await f.deleteReportImage('/assets/uploads/files/reports/../secret.jpg'), false);
  await fs.access(outside);
});

test('never maps encoded traversal or the namespace root to a file', async (t) => {
  const f = await fixture(t);
  const canonical = await writeImage(f.config.uploadsDirectory, 'keep.jpg');

  // The namespace root (with or without a trailing slash) is not a file.
  assert.equal(await f.deleteReportImage('/assets/uploads/files/reports'), false);
  assert.equal(await f.deleteReportImage('/assets/uploads/files/reports/'), false);
  await fs.access(canonical);

  // Percent-encoded dots stay a literal name; no decoding means no traversal.
  assert.equal(await f.deleteReportImage('/assets/uploads/files/reports/%2e%2e/keep.jpg'), false);
  await fs.access(canonical);

  // Backslash separators map to the canonical path, never outside it.
  const slashed = await writeImage(f.config.uploadsDirectory, '2026-09-15/slash.jpg');
  assert.equal(
    await f.deleteReportImage('/assets/uploads/files/reports\\2026-09-15\\slash.jpg'),
    true
  );
  await assert.rejects(fs.access(slashed));
});
