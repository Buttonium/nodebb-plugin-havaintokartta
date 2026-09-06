'use strict';

const { db } = require('./nodebb');
const { deleteReportImage } = require('./upload');
const {
  normalizeCoordinate,
  parsePositiveInteger,
  parseReportImageUrls,
  toBoolean,
  toNullableString,
} = require('./utils');

const KEYS = {
  allReports: 'havaintokartta:reports:all',
  publicReports: 'havaintokartta:reports:public',
  report(reportId) {
    return `havaintokartta:report:${reportId}`;
  },
  userReports(uid) {
    return `havaintokartta:reports:user:${uid}`;
  },
};

function serializeReport(report) {
  return {
    id: String(report.id),
    tid: String(report.tid ?? ''),
    topicSlug: String(report.topicSlug ?? ''),
    topicUrl: String(report.topicUrl ?? ''),
    creatorUid: String(report.creatorUid ?? ''),
    citySlug: String(report.citySlug ?? ''),
    lat: String(report.lat ?? ''),
    lng: String(report.lng ?? ''),
    description: String(report.description ?? ''),
    images: String(report.images ?? ''),
    stage: String(report.stage ?? ''),
    public: report.public ? '1' : '0',
    moderationStatus: String(report.moderationStatus ?? ''),
    departmentComment: String(report.departmentComment ?? ''),
    doneComment: String(report.doneComment ?? ''),
    publishImage: report.publishImage ? '1' : '0',
    publishImageDepartment: report.publishImageDepartment ? '1' : '0',
    reviewedByUid: String(report.reviewedByUid ?? ''),
    reviewedBy: String(report.reviewedBy ?? ''),
    reviewedAt: String(report.reviewedAt ?? ''),
    doneByUid: String(report.doneByUid ?? ''),
    doneBy: String(report.doneBy ?? ''),
    doneAt: String(report.doneAt ?? ''),
    createdAt: String(report.createdAt ?? ''),
    updatedAt: String(report.updatedAt ?? ''),
  };
}

function deserializeReport(value) {
  if (!value || typeof value !== 'object' || !value.id) {
    return null;
  }

  return {
    id: String(value.id),
    tid: parsePositiveInteger(value.tid, 0) || null,
    topicSlug: toNullableString(value.topicSlug) || '',
    topicUrl: toNullableString(value.topicUrl) || '',
    creatorUid: toNullableString(value.creatorUid),
    citySlug: toNullableString(value.citySlug),
    lat: normalizeCoordinate(value.lat),
    lng: normalizeCoordinate(value.lng),
    description: toNullableString(value.description) || '',
    images: toNullableString(value.images),
    stage: parsePositiveInteger(value.stage, 1) || 1,
    public: toBoolean(value.public),
    moderationStatus: toNullableString(value.moderationStatus) || 'pending',
    departmentComment: toNullableString(value.departmentComment),
    doneComment: toNullableString(value.doneComment),
    publishImage: toBoolean(value.publishImage),
    publishImageDepartment: toBoolean(value.publishImageDepartment),
    reviewedByUid: toNullableString(value.reviewedByUid),
    reviewedBy: toNullableString(value.reviewedBy) || '',
    reviewedAt: toNullableString(value.reviewedAt),
    doneByUid: toNullableString(value.doneByUid),
    doneBy: toNullableString(value.doneBy) || '',
    doneAt: toNullableString(value.doneAt),
    createdAt: toNullableString(value.createdAt),
    updatedAt: toNullableString(value.updatedAt),
  };
}

function getScore(report) {
  const timestamp = Date.parse(report.updatedAt || report.createdAt || '') || Date.now();
  return timestamp;
}

async function saveReport(report) {
  const score = getScore(report);
  const reportKey = KEYS.report(report.id);

  // Track what succeeded so we can roll back in reverse order on failure.
  const done = [];

  try {
    await db.setObject(reportKey, serializeReport(report));
    done.push({ remove: () => db.delete(reportKey) });

    await db.sortedSetAdd(KEYS.allReports, score, report.id);
    done.push({ remove: () => db.sortedSetRemove(KEYS.allReports, report.id) });

    if (report.creatorUid) {
      const userKey = KEYS.userReports(report.creatorUid);
      await db.sortedSetAdd(userKey, score, report.id);
      done.push({ remove: () => db.sortedSetRemove(userKey, report.id) });
    }

    if (report.public) {
      await db.sortedSetAdd(KEYS.publicReports, score, report.id);
      done.push({ remove: () => db.sortedSetRemove(KEYS.publicReports, report.id) });
    } else if (typeof db.sortedSetRemove === 'function') {
      await db.sortedSetRemove(KEYS.publicReports, report.id);
      // Last operation; no rollback entry needed.
    }
  } catch (err) {
    // Roll back in reverse order
    for (let i = done.length - 1; i >= 0; i--) {
      try {
        await done[i].remove();
      } catch {
        // Rollback failure is non-fatal — propagate the original error
      }
    }
    throw err;
  }

  return report;
}

async function getReport(reportId) {
  return deserializeReport(await db.getObject(KEYS.report(reportId)));
}

async function getReports(reportIds) {
  return (await Promise.all((reportIds || []).map((reportId) => getReport(reportId))))
    .filter(Boolean);
}

async function listReportIds(key) {
  return db.getSortedSetRevRange(key, 0, -1);
}

async function listPublicReports() {
  return getReports(await listReportIds(KEYS.publicReports));
}

async function listAllReports() {
  return getReports(await listReportIds(KEYS.allReports));
}

async function listReportsByUser(uid) {
  return getReports(await listReportIds(KEYS.userReports(uid)));
}

/**
 * Find an active (non-completed) report within the given coordinate threshold.
 * Only checks stage 1 (new) and stage 2 (in progress) reports.
 * Stage 3 (valmis/done) reports are excluded so resolved issues don't block new ones.
 *
 * Fetches all reports in parallel via getReports() (which uses Promise.all)
 * instead of sequentially awaiting each report individually.
 *
 * @param {number} lat - Latitude to check against
 * @param {number} lng - Longitude to check against
 * @param {number} threshold - Coordinate difference threshold (~10m = 9e-5)
 * @returns {Object|null} The matching report object, or null if no duplicate found
 */
async function findDuplicateCoordinate(lat, lng, threshold) {
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return null;
  if (typeof threshold !== 'number' || threshold <= 0) return null;

  const reportIds = await listReportIds(KEYS.allReports);
  if (!reportIds.length) return null;

  // Fetch all reports in parallel instead of sequentially
  const reports = await getReports(reportIds);

  for (const report of reports) {
    // Skip completed (stage 3 = valmis) reports
    if (Number(report.stage) >= 3) continue;
    if (typeof report.lat !== 'number' || typeof report.lng !== 'number') continue;
    if (Math.abs(report.lat - lat) < threshold && Math.abs(report.lng - lng) < threshold) {
      return report;
    }
  }
  return null;
}

async function deleteReport(reportId) {
  const report = await getReport(reportId);
  if (!report) {
    return null;
  }

  // Delete associated image files from filesystem (best-effort).
  if (report.images) {
    const imageUrls = parseReportImageUrls(report.images);
    for (const imageUrl of imageUrls) {
      await deleteReportImage(imageUrl).catch((err) => {
        console.error('[havaintokartta] Image deletion failed:', err?.message || err);
      });
    }
  }

  const safeId = String(report.id).trim();
  await db.delete(KEYS.report(safeId));
  await db.sortedSetRemove(KEYS.allReports, safeId);

  if (typeof db.sortedSetRemove === 'function') {
    await db.sortedSetRemove(KEYS.publicReports, safeId);
    if (report.creatorUid) {
      await db.sortedSetRemove(KEYS.userReports(report.creatorUid), safeId);
    }
  } else {
    // Fallback: when sortedSetRemove is unavailable, remove the report ID
    // from sorted sets on next save by not re-adding it.
    // Orphaned entries will be filtered by getReports which returns null for deleted reports.
  }

  return report;
}

module.exports = {
  deleteReport,
  findDuplicateCoordinate,
  getReport,
  getReports,
  listAllReports,
  listPublicReports,
  listReportsByUser,
  saveReport,
};
