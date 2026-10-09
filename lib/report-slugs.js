'use strict';

const { db } = require('./nodebb');
const errors = require('./errors');
const store = require('./store');

const CLAIMS_KEY = 'havaintokartta:report-slug-claims';
const SEQUENCES_KEY = 'havaintokartta:report-slug-sequences';
const slugKey = slug => `havaintokartta:report-slug:${slug}`;

function slugifyReportTitle(title) {
  const slug = String(title || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  // ID-shaped titles must not shadow legacy UUID/numeric report links.
  return !slug ? 'ilmoitus' : /^(?:\d+|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(slug)
    ? `ilmoitus-${slug}` : slug;
}

async function reserveReportSlug(report) {
  const base = slugifyReportTitle(report.title);
  for (;;) {
    // Start at the next suffix, so backfilling many identical/empty titles
    // does not repeatedly probe every previously assigned slug.
    const suffix = Number(await db.incrObjectField(SEQUENCES_KEY, base));
    if (!Number.isSafeInteger(suffix) || suffix < 1) {
      throw errors.serviceUnavailable('Could not reserve report URL.');
    }
    const tail = suffix === 1 ? '' : `-${suffix}`;
    const candidate = `${base.slice(0, 120 - tail.length).replace(/-+$/g, '')}${tail}`;
    // NodeBB's atomic increment arbitrates across processes, including titles
    // such as "Silta 2" colliding with the second "Silta". Never recycle claims:
    // a deleted report's link must not start pointing at a different report.
    const count = Number(await db.incrObjectField(CLAIMS_KEY, candidate));
    if (!Number.isSafeInteger(count) || count < 1) {
      throw errors.serviceUnavailable('Could not reserve report URL.');
    }
    if (count !== 1) continue;
    await db.setObject(slugKey(candidate), { reportId: String(report.id) });
    return candidate;
  }
}

async function ensureReportSlug(report) {
  for (let attempt = 0; report && !report.slug && attempt < 3; attempt++) {
    const slug = await reserveReportSlug(report);
    try {
      return await store.saveReportSlug(report, slug);
    } catch (err) {
      if (err.status !== 409) throw err;
      // Another worker may have assigned a slug or edited the report. Keep
      // its committed state; the unused candidate index never resolves.
      report = await store.getReport(report.id);
    }
  }
  if (report && !report.slug) throw errors.conflict('Report changed while assigning its URL. Retry.');
  return report;
}

let migration;
let retryAt = 0;
let migrationRunning = false;
let retryRequested = false;

function deferReportSlugBackfill() {
  retryAt = Date.now() + 30_000;
  retryRequested = true;
  if (!migrationRunning) migration = null;
}

async function ensureLegacyReportSlugs() {
  if (Date.now() < retryAt) return;
  if (!migration) {
    migrationRunning = true;
    retryRequested = false;
    migration = (async () => {
      const reports = await store.listAllReports();
      // Backfill oldest first so duplicate legacy titles receive stable suffixes.
      reports.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
        || a.id.localeCompare(b.id));
      for (const report of reports) await ensureReportSlug(report);
    })().catch(err => {
      deferReportSlugBackfill();
      console.warn('[havaintokartta] Report URL backfill deferred; UUID links remain available:', err?.message || err);
    }).finally(() => {
      migrationRunning = false;
      if (retryRequested) migration = null;
    });
  }
  return migration;
}

async function getReportBySlug(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) return null;
  const index = await db.getObject(slugKey(slug));
  if (!index?.reportId) return null;
  const report = await store.getReport(index.reportId);
  // Candidate indexes written before a failed save, and deleted reports, must
  // never resolve. The authoritative record owns its one permanent slug.
  return report?.slug === slug ? report : null;
}

module.exports = { deferReportSlugBackfill, ensureLegacyReportSlugs, ensureReportSlug, getReportBySlug, reserveReportSlug, slugifyReportTitle };
