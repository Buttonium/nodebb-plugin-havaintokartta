'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');

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
// Must match MAX_TITLE_LENGTH in the havaintokartta app.
const MAX_TITLE_LENGTH = 100;
const MAX_TOPIC_TITLE_LENGTH = 120;
const CITY_SLUG = 'ylivieska';

function buildTopicTitle(payload) {
  const citySlug = sanitizeSingleLineText(payload.citySlug, 30);
  const cityPrefix = citySlug ? `[${citySlug}] ` : '';
  const prefix = `[Havaintokartta] ${cityPrefix}`;
  // Prefer the report title. Legacy reports (created before the title field
  // existed) fall back to the description preview.
  const rawTitle =
    sanitizeSingleLineText(payload.title, MAX_TITLE_LENGTH) ||
    sanitizeSingleLineText(payload.description, 60) ||
    'Uusi ilmoitus';
  // Leave room for the prefix so the title is not cut off by the hard cap.
  const titleBudget = Math.max(20, MAX_TOPIC_TITLE_LENGTH - prefix.length);
  return sanitizeSingleLineText(
    `${prefix}${sanitizeSingleLineText(rawTitle, titleBudget)}`,
    MAX_TOPIC_TITLE_LENGTH
  );
}

let reportDateFormatter;

// Formats a stored ISO timestamp as a Finnish date (e.g. 11.9.2026) in the
// city's timezone, so a late-evening submission does not show the next day.
// The numeric parts are joined manually so the output format never depends on
// which locale data the runtime bundles.
function formatReportDate(value) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) {
    return '';
  }

  const date = new Date(parsed);
  try {
    if (!reportDateFormatter) {
      reportDateFormatter = new Intl.DateTimeFormat('fi-FI', {
        timeZone: 'Europe/Helsinki',
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
      });
    }

    const parts = reportDateFormatter.formatToParts(date);
    const day = parts.find((part) => part.type === 'day')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const year = parts.find((part) => part.type === 'year')?.value;
    if (day && month && year) {
      return `${Number(day)}.${Number(month)}.${year}`;
    }
  } catch (err) {
    // Timezone data unavailable — fall through to the UTC fallback below.
  }

  // Fallback for constrained ICU builds: UTC-based Finnish date.
  const [year, month, day] = date.toISOString().slice(0, 10).split('-');
  return `${Number(day)}.${Number(month)}.${year}`;
}

function buildTopicContent(payload) {
  // The stored `images` field is always a canonical JSON array (enforced in
  // normalizeCreatePayload), so it is the single source of truth here.
  const imageCount = parseReportImageUrls(payload.images).length;
  const title = sanitizeSingleLineText(payload.title, MAX_TITLE_LENGTH);
  const createdDate = formatReportDate(payload.createdAt);

  const lines = [
    title ? `Havaintokartta-ilmoitus: ${title}` : 'Havaintokartta-ilmoitus',
  ];
  if (createdDate) {
    lines.push(`Luotu: ${createdDate}`);
  }

  lines.push(
    '',
    'Ilmoittajan viesti:',
    payload.description || 'Ei kuvausta.',
    '',
    `Kuvia mukana: ${imageCount > 0 ? `${imageCount} kpl` : 'ei'}`
  );

  return lines.join('\n');
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
    lines.push('Käsittelyn kommentti:');
    lines.push(payload.reviewComment);
  }

  if (appUrl && report.id) {
    lines.push('');
    lines.push(`Ilmoitus: ${appUrl}/ilmoitus/${report.id}`);
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
    lines.push(`Ilmoitus: ${appUrl}/ilmoitus/${report.id}`);
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

    const uploadPrefix = getReportsUploadPrefix();
    for (const url of imageUrls) {
      if (!isReportsUploadReference(url, uploadPrefix)) {
        console.warn(
          '[havaintokartta] createReport: rejected non-upload image reference: %s',
          url.slice(0, 300)
        );
        throw errors.badRequest('Images must be uploaded via the reports upload endpoint.');
      }
    }
  }

  return {
    creatorUid: sanitizeSingleLineText(payload?.creatorUid, 80),
    citySlug: CITY_SLUG,
    lat: normalizeCoordinate(payload?.lat, 'lat'),
    lng: normalizeCoordinate(payload?.lng, 'lng'),
    title: sanitizeSingleLineText(payload?.title, MAX_TITLE_LENGTH),
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

// Creates the forum topic for a report. `authorUid` is the reviewing
// operator: the topic is their approved record of the citizen report, so it
// is posted under their forum account (not the reporter's).
async function createTopic(payload, authorUid) {
  const { categoryId, baseUrl } = getConfig();
  if (!categoryId) {
    throw errors.serviceUnavailable('NODEBB_HAVAINTOKARTTA_CATEGORY_ID is not configured.');
  }

  const result = await topics.post({
    uid: Number(authorUid),
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
    title: normalizedPayload.title,
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

/**
 * Update a stage 1 report (creator only): description and/or images. The
 * caller sends the full new image list; removed files are deleted. The
 * write atomically compares its snapshot revision (a concurrent review
 * must yield 409, not overwrite the newer state).
 */
async function updateReport(reportId, payload) {
  const actorUid = sanitizeSingleLineText(payload?.actorUid, 80);
  if (!actorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  const normalizedReportId = sanitizeSingleLineText(reportId, 80);
  if (!normalizedReportId) {
    throw errors.badRequest('reportId is required.');
  }

  const report = await store.getReport(normalizedReportId);
  if (!report) {
    throw errors.notFound('Report not found.');
  }

  if (report.stage !== 1) {
    throw errors.conflict('Only stage 1 reports can be updated.');
  }

  if (String(report.creatorUid ?? '').trim() !== actorUid) {
    throw errors.forbidden('Only the report creator can update the report.');
  }

  let title = report.title;
  if (payload?.title != null) {
    title = sanitizeSingleLineText(payload.title, MAX_TITLE_LENGTH);
    if (!title) {
      throw errors.badRequest('title is required.');
    }
  }

  let description = report.description;
  if (payload?.description != null) {
    description = sanitizeMultilineText(payload.description, MAX_DESCRIPTION_LENGTH);
    if (!description) {
      throw errors.badRequest('description is required.');
    }
  }

  const oldImageUrls = parseReportImageUrls(report.images);
  let newImageUrls = oldImageUrls;
  const removedImageUrls = [];

  if (payload?.images != null) {
    // No display cap: reject over-limit input explicitly instead of truncating.
    const parsedImageUrls = parseReportImageUrls(payload.images, Number.MAX_SAFE_INTEGER);

    if (!parsedImageUrls.length) {
      throw errors.badRequest('images must contain at least one valid URL.');
    }
    if (parsedImageUrls.length > MAX_REPORT_IMAGES) {
      throw errors.badRequest(`At most ${MAX_REPORT_IMAGES} images are allowed per report.`);
    }

    const oldImageSet = new Set(oldImageUrls);
    const expectedPrefix = getReportsUploadPrefix();

    for (const url of parsedImageUrls) {
      if (oldImageSet.has(url)) continue;
      if (!isReportsUploadReference(url, expectedPrefix)) {
        console.warn(
          '[havaintokartta] updateReport: rejected non-upload image reference: %s',
          url.slice(0, 300)
        );
        throw errors.badRequest('New images must be uploaded via the reports upload endpoint.');
      }
    }

    newImageUrls = parsedImageUrls;
    for (const url of oldImageUrls) {
      if (!parsedImageUrls.includes(url)) {
        removedImageUrls.push(url);
      }
    }
  }

  // Optimistic gate: abort if the report changed during this request,
  // instead of clobbering the newer state with our stale snapshot.
  const fresh = await store.getReport(normalizedReportId);
  if (!fresh || fresh.stage !== 1 || fresh.updatedAt !== report.updatedAt) {
    throw errors.conflict('Report changed during update. Reload and try again.');
  }

  const now = new Date().toISOString();
  const updatedReport = {
    ...report,
    title,
    description,
    images: newImageUrls.length ? JSON.stringify(newImageUrls) : null,
    updatedAt: now,
  };

  const savedReport = await store.saveReport(updatedReport, report);

  // Delete files only after the save, so a failed save can't leave the
  // report referencing deleted files.
  for (const url of removedImageUrls) {
    await deleteReportImage(url).catch((err) => {
      console.error('[havaintokartta] Image deletion on update failed:', err?.message || err);
    });
  }

  return savedReport;
}

function getReportsUploadPrefix() {
  const { uploadsUrlPrefix } = getConfig();
  return `/${String(uploadsUrlPrefix ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

// References this plugin's report uploads dir on the forum's own origin.
// Relative paths are same-origin by definition; absolute URLs must match the
// configured forum origin so a foreign host cannot masquerade as an upload.
function isReportsUploadReference(url, expectedPrefix) {
  const candidate = String(url ?? '').trim();
  if (!candidate || candidate.startsWith('//')) {
    return false;
  }

  let pathname = candidate;
  if (/^[a-z][\w+.-]*:/i.test(candidate)) {
    const { baseUrl } = getConfig();
    if (!baseUrl) {
      return false;
    }

    let parsedUrl;
    let parsedBaseUrl;
    try {
      parsedUrl = new URL(candidate);
      parsedBaseUrl = new URL(baseUrl);
    } catch {
      return false;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }
    if (parsedUrl.origin !== parsedBaseUrl.origin) {
      return false;
    }

    pathname = parsedUrl.pathname;
  } else if (candidate.startsWith('/')) {
    pathname = new URL(candidate, 'https://uploads.invalid').pathname;
  } else {
    return false;
  }

  // Resolve escapes and dot segments the way the browser and the static file
  // server do, so `.../reports/../news/x.jpg` cannot pass as an upload.
  try {
    pathname = path.posix.normalize(decodeURIComponent(pathname).replace(/\\/g, '/'));
  } catch {
    return false;
  }

  return pathname === expectedPrefix || pathname.startsWith(`${expectedPrefix}/`);
}

async function reviewReport(reportId, payload) {
  const normalizedPayload = normalizeReviewPayload(payload);
  if (!normalizedPayload.actorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  let report = await store.getReport(reportId);
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
    topic = await createTopic(report, actor.uid);
    // Persist the tid immediately (keeping stage 1) so a retry can detect
    // the existing topic instead of creating a duplicate.
    report = await store.saveReport({
      ...report,
      tid: topic.tid,
      topicSlug: topic.topicSlug,
      topicUrl: topic.topicUrl,
      updatedAt: now,
    }, report);
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

  // Clear references in the committed record before deleting any files.
  const removedImages = !normalizedPayload.publishImage
    ? parseReportImageUrls(report.images) : [];
  if (!normalizedPayload.publishImage) updatedReport.images = null;

  // Save the state change BEFORE posting the forum reply. The report's
  // stage in the database is the source of truth; the forum reply is a
  // best-effort notification. This prevents duplicate replies on retry
  // because the stage check blocks a second attempt once stage advances.
  const savedReport = await store.saveReport(updatedReport, report);
  for (const imageUrl of removedImages) {
    await deleteReportImage(imageUrl).catch((err) => {
      console.error('[havaintokartta] Image deletion on review failed:', err?.message || err);
    });
  }


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
  const savedReport = await store.saveReport(updatedReport, report);

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
  const normalizedLat = normalizeCoordinate(lat, 'lat');
  const normalizedLng = normalizeCoordinate(lng, 'lng');
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
  updateReport,
};
