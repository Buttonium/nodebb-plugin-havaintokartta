'use strict';

const errors = require('./errors');
const reports = require('./reports');
const services = require('./services');
const sso = require('./sso');
const upload = require('./upload');
const { getConfig } = require('./config');

function getBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
}

function getActorUid(req) {
  const headerActorUid = String(req.headers['x-havaintokartta-actor-uid'] ?? '').trim();
  if (headerActorUid) {
    return headerActorUid;
  }

  return getBody(req).actorUid;
}

function isOriginAllowed(origin) {
  const { appUrl, ylivieskahubUrl, palvelukarttaUrl } = getConfig();
  const allowedOrigins = [appUrl, ylivieskahubUrl, palvelukarttaUrl]
    .map((u) => String(u ?? '').trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    return false;
  }

  const trimmedOrigin = String(origin ?? '').trim();
  return allowedOrigins.includes(trimmedOrigin);
}

async function createReport(req, res) {
  const report = await reports.createReport(getBody(req));
  res.status(201).json({ report });
}

async function checkDuplicateReport(req, res) {
  const { lat, lng } = getBody(req);
  const existing = await reports.checkDuplicateCoordinate(lat, lng);
  res.json({ duplicate: !!existing, existingReportId: existing?.id || null });
}

async function uploadReportImage(req, res) {
  const result = await upload.uploadReportImage(req);
  res.status(201).json(result);
}

async function uploadNewsImage(req, res) {
  const result = await upload.uploadNewsImage(req);
  res.status(201).json(result);
}

async function deleteNewsImage(req, res) {
  const actorUid = String(getActorUid(req) ?? '').trim();
  if (!actorUid) {
    throw errors.badRequest('actorUid is required.');
  }
  await sso.assertUutisetWriter(actorUid);

  const body = getBody(req);
  const imageUrl = String(body?.imageUrl ?? '').trim();
  const deleted = await upload.deleteNewsImage(imageUrl);
  res.json({ deleted });
}

async function uploadEventImage(req, res) {
  const result = await upload.uploadEventImage(req);
  res.status(201).json(result);
}

async function deleteEventImage(req, res) {
  const actorUid = String(getActorUid(req) ?? '').trim();
  if (!actorUid) {
    throw errors.badRequest('actorUid is required.');
  }
  await sso.assertEventMaintainer(actorUid);

  const body = getBody(req);
  const imageUrl = String(body?.imageUrl ?? '').trim();
  const deleted = await upload.deleteEventImage(imageUrl);
  res.json({ deleted });
}

async function checkForumLoginStatus(req, res) {
  const origin = String(req.headers.origin ?? '').trim();
  const allowedOrigin = isOriginAllowed(origin) ? origin : '';

  if (allowedOrigin) {
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
  }
  // No CORS headers for disallowed origins — browser blocks the request.
  // Return the authenticated user's uid and current role so the client
  // can verify both identity and permissions on every poll.
  if (req.loggedIn && req.uid) {
    const roles = await sso.resolveRoles(req.uid);
    return res.json({ uid: String(req.uid), roles });
  }
  res.sendStatus(401);
}

async function syncAuth(req, res) {
  const { appUrl, ylivieskahubUrl, palvelukarttaUrl } = getConfig();
  const allowedUrls = [appUrl, ylivieskahubUrl, palvelukarttaUrl]
    .map((u) => String(u ?? '').trim())
    .filter(Boolean);
  const state = sso.parseForumSyncStateToken(req.query.state, allowedUrls);
  if (!state) {
    // Invalid/expired state token — redirect to app login page instead of
    // returning raw JSON to the browser.
    try {
      const loginUrl = new URL('/kirjaudu', appUrl);
      loginUrl.searchParams.set('error', 'forum-auth-failed');
      return res.redirect(loginUrl.toString());
    } catch {
      // appUrl misconfigured or missing — safe same-origin fallback
      return res.redirect('/');
    }
  }

  // Not logged into NodeBB — redirect to forum login/register
  if (!req.loggedIn || !req.uid) {
    // Best-effort: save current URL so we can return to it after login.
    // If the session store is down, the user still gets to the login page.
    try {
      await sso.persistCurrentUrlAsReturnTo(req);
    } catch (err) {
      console.warn('[havaintokartta] Failed to persist returnTo URL:', err?.message || err);
    }
    return res.redirect(sso.getLoginRedirectPath(state.mode));
  }

  // Logged in — build auth payload, store exchange code, redirect back to app
  try {
    const authPayload = await sso.buildAppAuthPayload(req.uid);
    const exchangeCode = sso.createExchangeCode();
    await sso.storeExchangeCode(exchangeCode, authPayload);

    // Fire-and-forget cleanup — don't let a session-store failure block
    // a successful login.
    sso.clearReturnTo(req).catch((err) => {
      console.warn('[havaintokartta] Failed to clear returnTo from session:', err?.message || err);
    });

    return res.redirect(sso.buildAuthenticatedRedirectUrl({
      returnTo: state.returnTo,
      redirectTo: state.redirectTo,
      exchangeCode,
    }));
  } catch (err) {
    console.error('[havaintokartta] syncAuth error:', err);

    // Redirect to app login page so the user sees a friendly error + retry.
    // Use configured appUrl directly instead of trusting state.returnTo origin.
    try {
      const loginUrl = new URL('/kirjaudu', appUrl);
      loginUrl.searchParams.set('error', 'forum-auth-failed');
      loginUrl.searchParams.set('redirectTo', state.redirectTo);
      return res.redirect(loginUrl.toString());
    } catch {
      return res.redirect('/');
    }
  }
}

async function getPublicReports(req, res) {
  const reportsList = await reports.getPublicReports();
  res.json({ reports: reportsList });
}

async function getMineReports(req, res) {
  const reportsList = await reports.getMineReports(req.query.requesterUid);
  res.json({ reports: reportsList });
}

async function getAllReports(req, res) {
  const reportsList = await reports.getAllReports();
  res.json({ reports: reportsList });
}

async function getSingleReport(req, res) {
  const report = await reports.getSingleReport(req.params.id);
  res.json({ report });
}

async function reviewReport(req, res) {
  const report = await reports.reviewReport(req.params.id, {
    ...getBody(req),
    actorUid: getActorUid(req),
  });
  res.json({ report });
}

async function markReportDone(req, res) {
  const report = await reports.markReportDone(req.params.id, {
    ...getBody(req),
    actorUid: getActorUid(req),
  });
  res.json({ report });
}

async function getActors(req, res) {
  const reportIds = Array.isArray(req.query.reportId)
    ? req.query.reportId
    : req.query.reportId == null
      ? []
      : [req.query.reportId];

  const actors = await reports.getActors(reportIds);
  res.json({ actors });
}

async function getStats(req, res) {
  const stats = await reports.getStats();
  res.json({ stats });
}

async function deleteReport(req, res) {
  const deleted = await reports.deleteReport(req.params.id, {
    ...getBody(req),
    actorUid: getActorUid(req),
  });
  res.json({ report: deleted });
}

/**
 * Exchange a single-use code for a session token.
 * Called server-to-server by the havaintokartta backend.
 */
async function exchangeCode(req, res) {
  const code = String(req.body?.code ?? '').trim();
  if (!code) {
    throw errors.badRequest('A valid exchange code is required.');
  }

  const authPayload = await sso.retrieveAndConsumeExchangeCode(code);
  if (!authPayload) {
    throw errors.unauthorized('Invalid or expired exchange code.');
  }

  const sessionToken = sso.createAppSessionToken(authPayload);
  res.json({ sessionToken });
}

// ── Services (Palvelukartta) ──────────────────────────────────

async function getPublicServices(req, res) {
  const { searchParams } = new URL(req.url, 'http://localhost');
  const query = searchParams.get('q') || '';
  const categoriesParam = searchParams.get('categories') || '';
  const categories = categoriesParam ? categoriesParam.split(',').map((c) => c.trim()).filter(Boolean) : [];
  const includePrivate = searchParams.get('includePrivate') === 'true';

  const result = await services.searchServices({ query, categories, includePrivate });
  res.json({ services: result });
}

async function getSingleService(req, res) {
  const service = await services.getService(req.params.id);
  if (!service) {
    throw errors.notFound('Service not found.');
  }
  res.json({ service });
}

async function getSingleServiceBySlug(req, res) {
  const service = await services.getServiceBySlug(req.params.slug);
  if (!service) {
    throw errors.notFound('Service not found.');
  }
  res.json({ service });
}

async function getAllServices(req, res) {
  const result = await services.listAllServices({ includePrivate: true });
  res.json({ services: result });
}

async function createService(req, res) {
  const service = await services.createService(getBody(req), getActorUid(req));
  res.status(201).json({ service });
}

async function updateService(req, res) {
  const service = await services.updateService(req.params.id, getBody(req), getActorUid(req));
  res.json({ service });
}

async function deleteService(req, res) {
  const deleted = await services.deleteService(req.params.id, getActorUid(req));
  res.json({ service: deleted });
}

async function uploadServiceImage(req, res) {
  const result = await upload.uploadServiceImage(req);
  res.status(201).json(result);
}

async function deleteServiceImage(req, res) {
  const actorUid = String(getActorUid(req) ?? '').trim();
  if (!actorUid) {
    throw errors.badRequest('actorUid is required.');
  }
  await services.assertPalvelukarttaOperator(actorUid);

  const body = getBody(req);
  const imageUrl = String(body?.imageUrl ?? '').trim();
  const deleted = await upload.deleteServiceImage(imageUrl);
  res.json({ deleted });
}

/**
 * Revoke a session token by adding its signature to the deny list.
 * Receives the full token so the controller can extract the remaining TTL
 * and set a precise expiry on the deny-list entry.
 */
async function revokeToken(req, res) {
  const { token } = getBody(req);
  if (!token) {
    throw errors.badRequest('token is required.');
  }
  const result = sso.parseTokenForRevocation(token);
  if (!result) {
    throw errors.badRequest('Invalid token format.');
  }
  await sso.revokeTokenSignature(result.signature, result.remainingTtlSeconds);
  res.json({ revoked: true });
}

/**
 * Verify whether a token signature is in the deny list.
 * POST with body keeps the signature out of access logs.
 */
async function verifyToken(req, res) {
  const sig = String(getBody(req).tokenSignature ?? '').trim();
  if (!sig) {
    return res.json({ revoked: false });
  }
  const revoked = await sso.isTokenSignatureRevoked(sig);
  res.json({ revoked });
}

module.exports = {
  checkDuplicateReport,
  checkForumLoginStatus,
  createReport,
  createService,
  deleteEventImage,
  deleteNewsImage,
  deleteReport,
  deleteService,
  deleteServiceImage,
  exchangeCode,
  getActors,
  getAllReports,
  getAllServices,
  getMineReports,
  getPublicReports,
  getPublicServices,
  getSingleReport,
  getSingleService,
  getSingleServiceBySlug,
  getStats,
  markReportDone,
  reviewReport,
  revokeToken,
  syncAuth,
  updateService,
  uploadEventImage,
  uploadNewsImage,
  uploadReportImage,
  uploadServiceImage,
  verifyToken,
};
