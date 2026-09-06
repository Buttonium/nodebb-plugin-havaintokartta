'use strict';

const { randomUUID } = require('node:crypto');

const { getConfig } = require('./config');
const errors = require('./errors');
const { groups, topics, user } = require('./nodebb');
const store = require('./store');
const { deleteReportImage } = require('./upload');
const {
  buildTopicUrl,
  normalizeCoordinate,
  parsePositiveInteger,
  parseReportImageUrls,
  MAX_REPORT_IMAGES,
  sanitizeMultilineText,
  sanitizeSingleLineText,
} = require('./utils');

const MAX_DESCRIPTION_LENGTH = 500;
const CITY_SLUG = 'ylivieska';

function buildTopicTitle(payload) {
  const citySlug = sanitizeSingleLineText(payload.citySlug, 30);
  const descriptionPreview = sanitizeSingleLineText(payload.description, 60) || 'Uusi ilmoitus';
  const cityPrefix = citySlug ? `[${citySlug}] ` : '';
  return sanitizeSingleLineText(
    `[Havaintokartta] ${cityPrefix}${descriptionPreview}`,
    120
  );
}

function buildTopicContent(payload) {
  // The stored `images` field is always a canonical JSON array (enforced in
  // normalizeCreatePayload), so it is the single source of truth here.
  const imageCount = parseReportImageUrls(payload.images).length;
  return [
    'Havaintokartta-ilmoitus luotu sovelluksesta.',
    '',
    payload.description || 'Ei kuvausta.',
    '',
    `Kuvia mukana: ${imageCount > 0 ? `${imageCount} kpl` : 'ei'}`,
  ].join('\n');
}

function buildReviewReplyContent(report, actor, payload) {
  const { appUrl } = getConfig();
  const lines = [
    'Havaintokartta-ilmoitus on tarkistettu.',
    '',
    `Käsittelijä: ${actor.name || actor.uid}`,
    `Julkinen kartalla: kyllä`,
    `Kuvan julkaisu: ${payload.publishImage ? 'kyllä' : 'ei'}`,
  ];

  if (payload.reviewComment) {
    lines.push('');
    lines.push('Käsittelykommentti:');
    lines.push(payload.reviewComment);
  }

  if (appUrl && report.id) {
    lines.push('');
    lines.push(`Raportti: ${appUrl}/ilmoitus/${report.id}`);
  }

  return lines.join('\n');
}

function buildDoneReplyContent(report, actor, payload) {
  const { appUrl } = getConfig();
  const lines = [
    'Havaintokartta-ilmoitus on merkitty valmiiksi.',
    '',
    `Käsittelijä: ${actor.name || actor.uid}`,
  ];

  if (payload.doneComment) {
    lines.push('');
    lines.push('Valmistumiskommentti:');
    lines.push(payload.doneComment);
  }

  if (appUrl && report.id) {
    lines.push('');
    lines.push(`Raportti: ${appUrl}/ilmoitus/${report.id}`);
  }

  return lines.join('\n');
}

function normalizeCreatePayload(payload) {
  const rawImages = payload?.images;
  const hasImagesInput =
    Array.isArray(rawImages)
      ? rawImages.length > 0
      : typeof rawImages === 'string'
        ? rawImages.trim() !== '' && rawImages.trim() !== '[]'
        : rawImages != null;

  // Parse without the display cap so over-limit input is rejected
  // explicitly instead of being silently truncated (which would orphan
  // the extra uploaded files).
  const imageUrls = parseReportImageUrls(rawImages, Number.MAX_SAFE_INTEGER);

  if (hasImagesInput) {
    if (!imageUrls.length) {
      console.warn(
        '[havaintokartta] createReport: images provided but none are valid URLs: %s',
        String(rawImages).slice(0, 300)
      );
      throw errors.badRequest('images must contain at least one valid URL.');
    }
    if (imageUrls.length > MAX_REPORT_IMAGES) {
      console.warn(
        '[havaintokartta] createReport: rejected %d images (max %d)',
        imageUrls.length,
        MAX_REPORT_IMAGES
      );
      throw errors.badRequest(`At most ${MAX_REPORT_IMAGES} images are allowed per report.`);
    }
  }

  return {
    creatorUid: sanitizeSingleLineText(payload?.creatorUid, 80),
    citySlug: CITY_SLUG,
    lat: normalizeCoordinate(payload?.lat),
    lng: normalizeCoordinate(payload?.lng),
    description: sanitizeMultilineText(payload?.description, MAX_DESCRIPTION_LENGTH),
    // Stored as a JSON array of URL strings so a report can carry multiple images.
    images: imageUrls.length ? JSON.stringify(imageUrls) : null,
  };
}

function normalizeReviewPayload(payload) {
  return {
    actorUid: sanitizeSingleLineText(payload?.actorUid, 80),
    reviewComment: sanitizeMultilineText(payload?.reviewComment, MAX_DESCRIPTION_LENGTH),
    publishImage: Boolean(payload?.publishImage),
  };
}

function normalizeDonePayload(payload) {
  return {
    actorUid: sanitizeSingleLineText(payload?.actorUid, 80),
    doneComment: sanitizeMultilineText(payload?.doneComment, MAX_DESCRIPTION_LENGTH),
  };
}

function normalizeTopicResult(result) {
  return result?.topicData || result?.topic || result || null;
}

async function resolveActor(actorUid) {
  const fields = await user.getUserFields(actorUid, ['username', 'displayname']);
  return {
    uid: String(actorUid),
    name: String(fields?.displayname || fields?.username || '').trim(),
  };
}

async function assertOperator(actorUid) {
  const { operatorGroups } = getConfig();
  for (const groupName of operatorGroups) {
    const isMember = await groups.isMember(actorUid, groupName);
    if (isMember) {
      return;
    }
  }

  throw errors.forbidden('Operator access is required.');
}

async function createTopic(payload) {
  const { categoryId, baseUrl } = getConfig();
  if (!categoryId) {
    throw errors.serviceUnavailable('NODEBB_HAVAINTOKARTTA_CATEGORY_ID is not configured.');
  }

  const result = await topics.post({
    uid: Number(payload.creatorUid),
    cid: categoryId,
    title: buildTopicTitle(payload),
    content: buildTopicContent(payload),
    tags: ['havaintokartta', payload.citySlug].filter(Boolean),
  });

  const topic = normalizeTopicResult(result);
  const tid = parsePositiveInteger(topic?.tid ?? topic?.id, 0);
  if (!tid) {
    throw errors.serviceUnavailable('NodeBB topic creation failed.');
  }

  let slug = sanitizeSingleLineText(topic?.slug, 240) || '';
  if (!slug && typeof topics.getTopicFields === 'function') {
    const topicFields = await topics.getTopicFields(tid, ['slug']);
    slug = sanitizeSingleLineText(topicFields?.slug, 240) || '';
  }

  return {
    tid,
    topicSlug: slug,
    topicUrl: buildTopicUrl(baseUrl, tid, slug),
  };
}

async function appendTopicReply(report, actorUid, content) {
  const tid = parsePositiveInteger(report?.tid, 0);
  if (!tid || !actorUid || !content) {
    console.warn('[havaintokartta] appendTopicReply skipped: tid=%s, actorUid=%s, contentLen=%s',
      tid, actorUid, content?.length);
    return;
  }

  await topics.reply({
    uid: Number(actorUid),
    tid,
    content,
  });
}

async function createReport(payload) {
  const normalizedPayload = normalizeCreatePayload(payload);

  if (!normalizedPayload.creatorUid) {
    throw errors.badRequest('creatorUid is required.');
  }

  if (!normalizedPayload.description) {
    throw errors.badRequest('description is required.');
  }

  if (normalizedPayload.lat == null || normalizedPayload.lng == null) {
    throw errors.badRequest('lat and lng are required.');
  }

  const now = new Date().toISOString();

  const report = {
    id: randomUUID(),
    tid: null,
    topicSlug: '',
    topicUrl: '',
    creatorUid: normalizedPayload.creatorUid,
    citySlug: normalizedPayload.citySlug,
    lat: normalizedPayload.lat,
    lng: normalizedPayload.lng,
    description: normalizedPayload.description,
    images: normalizedPayload.images,
    stage: 1,
    public: false,
    moderationStatus: 'pending',
    departmentComment: null,
    doneComment: null,
    publishImage: false,
    publishImageDepartment: false,
    reviewedByUid: null,
    reviewedBy: '',
    reviewedAt: null,
    doneByUid: null,
    doneBy: '',
    doneAt: null,
    createdAt: now,
    updatedAt: now,
  };

  return store.saveReport(report);
}

async function reviewReport(reportId, payload) {
  const normalizedPayload = normalizeReviewPayload(payload);
  if (!normalizedPayload.actorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  const report = await store.getReport(reportId);
  if (!report) {
    throw errors.notFound('Report not found.');
  }

  if (report.stage !== 1) {
    throw errors.conflict('Only stage 1 reports can be reviewed.');
  }

  await assertOperator(normalizedPayload.actorUid);
  const actor = await resolveActor(normalizedPayload.actorUid);
  const now = new Date().toISOString();

  // Create the forum topic, or reuse it if a previous attempt already
  // created one but failed before completing the review. This prevents
  // duplicate topics when the operator retries after a transient error.
  let topic;
  if (report.tid) {
    topic = {
      tid: report.tid,
      topicSlug: report.topicSlug,
      topicUrl: report.topicUrl,
    };
  } else {
    topic = await createTopic(report);
    // Persist the tid immediately (keeping stage 1) so a retry can detect
    // the existing topic instead of creating a duplicate.
    await store.saveReport({
      ...report,
      tid: topic.tid,
      topicSlug: topic.topicSlug,
      topicUrl: topic.topicUrl,
      updatedAt: now,
    });
  }

  const updatedReport = {
    ...report,
    tid: topic.tid,
    topicSlug: topic.topicSlug,
    topicUrl: topic.topicUrl,
    stage: 2,
    public: true,
    moderationStatus: 'approved',
    departmentComment: normalizedPayload.reviewComment || null,
    publishImage: normalizedPayload.publishImage,
    publishImageDepartment: false,
    reviewedByUid: actor.uid,
    reviewedBy: actor.name,
    reviewedAt: now,
    updatedAt: now,
  };

  // If operator chose not to publish the images, delete them from disk and clear the reference.
  // This ensures the images cannot be accessed via direct URL after review.
  if (!normalizedPayload.publishImage && report.images) {
    const imageUrls = parseReportImageUrls(report.images);
    for (const imageUrl of imageUrls) {
      await deleteReportImage(imageUrl).catch((err) => {
        console.error('[havaintokartta] Image deletion on review failed:', err?.message || err);
      });
    }
    updatedReport.images = null;
  }

  // Save the state change BEFORE posting the forum reply. The report's
  // stage in the database is the source of truth; the forum reply is a
  // best-effort notification. This prevents duplicate replies on retry
  // because the stage check blocks a second attempt once stage advances.
  const savedReport = await store.saveReport(updatedReport);

  try {
    await appendTopicReply(
      updatedReport,
      actor.uid,
      buildReviewReplyContent(updatedReport, actor, normalizedPayload)
    );
  } catch (err) {
    console.error('[havaintokartta] Failed to post review reply:', err?.message || err);
  }

  return savedReport;
}

async function markReportDone(reportId, payload) {
  const normalizedPayload = normalizeDonePayload(payload);
  if (!normalizedPayload.actorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  const report = await store.getReport(reportId);
  if (!report) {
    throw errors.notFound('Report not found.');
  }

  if (report.stage !== 2) {
    throw errors.conflict('Only stage 2 reports can be marked done.');
  }

  await assertOperator(normalizedPayload.actorUid);
  const actor = await resolveActor(normalizedPayload.actorUid);
  const now = new Date().toISOString();

  const updatedReport = {
    ...report,
    stage: 3,
    doneComment: normalizedPayload.doneComment || null,
    doneByUid: actor.uid,
    doneBy: actor.name,
    doneAt: now,
    updatedAt: now,
  };

  // Save the state change BEFORE posting the forum reply. The report's
  // stage in the database is the source of truth; the forum reply is a
  // best-effort notification. This prevents duplicate replies on retry
  // because the stage check blocks a second attempt once stage advances.
  const savedReport = await store.saveReport(updatedReport);

  try {
    await appendTopicReply(
      report,
      actor.uid,
      buildDoneReplyContent(report, actor, normalizedPayload)
    );
  } catch (err) {
    console.error('[havaintokartta] Failed to post done reply:', err?.message || err);
  }

  return savedReport;
}

async function getPublicReports() {
  return store.listPublicReports();
}

async function getMineReports(requesterUid) {
  const normalizedUid = sanitizeSingleLineText(requesterUid, 80);
  if (!normalizedUid) {
    throw errors.badRequest('requesterUid is required.');
  }

  return store.listReportsByUser(normalizedUid);
}

async function getAllReports() {
  return store.listAllReports();
}

async function getSingleReport(reportId) {
  const normalizedReportId = sanitizeSingleLineText(reportId, 80);
  if (!normalizedReportId) {
    throw errors.badRequest('reportId is required.');
  }

  const report = await store.getReport(normalizedReportId);
  if (!report) {
    throw errors.notFound('Report not found.');
  }

  return report;
}

async function getStats() {
  const reports = await store.listAllReports();
  const totalCreated = reports.length;
  let pendingReview = 0;
  let currentInProgress = 0;
  let totalDone = 0;

  for (const report of reports) {
    const stage = Number(report.stage) || 1;
    if (stage === 1) {
      pendingReview += 1;
    }
    if (stage === 2) {
      currentInProgress += 1;
    }
    if (stage === 3) {
      totalDone += 1;
    }
  }

  return {
    totalCreated,
    pendingReview,
    currentInProgress,
    totalDone,
  };
}

async function getActors(reportIds) {
  const ids = (Array.isArray(reportIds) ? reportIds : [reportIds])
    .map((reportId) => sanitizeSingleLineText(reportId, 80))
    .filter(Boolean);

  if (!ids.length) {
    return [];
  }

  const reports = await store.getReports(ids);
  return ids.map((reportId) => {
    const report = reports.find((entry) => entry.id === reportId);
    return {
      reportId,
      reviewedByUid: report?.reviewedByUid ?? null,
      reviewedBy: report?.reviewedBy ?? '',
      reviewedAt: report?.reviewedAt ?? null,
      doneByUid: report?.doneByUid ?? null,
      doneBy: report?.doneBy ?? '',
      doneAt: report?.doneAt ?? null,
    };
  });
}

async function deleteReport(reportId, payload) {
  const normalizedPayload = {
    actorUid: sanitizeSingleLineText(payload?.actorUid, 80),
  };

  if (!normalizedPayload.actorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  await assertOperator(normalizedPayload.actorUid);

  const normalizedReportId = sanitizeSingleLineText(reportId, 80);
  if (!normalizedReportId) {
    throw errors.badRequest('reportId is required.');
  }

  const deleted = await store.deleteReport(normalizedReportId);
  if (!deleted) {
    throw errors.notFound('Report not found.');
  }

  return deleted;
}

// Duplicate coordinate threshold — ~10 meters.
const DUPLICATE_COORD_THRESHOLD = 9e-5;

async function checkDuplicateCoordinate(lat, lng) {
  const normalizedLat = normalizeCoordinate(lat);
  const normalizedLng = normalizeCoordinate(lng);
  if (normalizedLat === null || normalizedLng === null) {
    throw errors.badRequest('Valid coordinates are required.');
  }
  const existing = await store.findDuplicateCoordinate(normalizedLat, normalizedLng, DUPLICATE_COORD_THRESHOLD);
  return existing;
}

module.exports = {
  checkDuplicateCoordinate,
  createReport,
  deleteReport,
  getActors,
  getAllReports,
  getMineReports,
  getPublicReports,
  getSingleReport,
  getStats,
  markReportDone,
  reviewReport,
};
