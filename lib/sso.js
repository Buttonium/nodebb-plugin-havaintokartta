'use strict';

const { randomBytes, createHmac, timingSafeEqual, createHash } = require('node:crypto');

const nconf = require.main.require('nconf');

const errors = require('./errors');
const { getConfig } = require('./config');
const { db, groups, user } = require('./nodebb');
const { parsePositiveInteger } = require('./utils');

const CITY_SLUG = 'ylivieska';
const DEFAULT_APP_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const APP_SESSION_SECRET = String(process.env.APP_SESSION_SECRET ?? '').trim();
const APP_SESSION_TTL_SECONDS = parsePositiveInteger(
  process.env.APP_SESSION_TTL_SECONDS,
  DEFAULT_APP_SESSION_TTL_SECONDS
);
const EXCHANGE_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EXCHANGE_CODE_KEY = (code) => `havaintokartta:exchange:${code}`;

function createSignature(value) {
  return createHmac('sha256', APP_SESSION_SECRET).update(value).digest('base64url');
}

function createExchangeCode() {
  return randomBytes(32).toString('hex');
}

async function storeExchangeCode(code, authPayload) {
  await db.setObject(EXCHANGE_CODE_KEY(code), {
    payload: authPayload,
    exp: Date.now() + EXCHANGE_CODE_TTL_MS,
  });
}

async function retrieveAndConsumeExchangeCode(code) {
  const key = EXCHANGE_CODE_KEY(code);

  // Atomically claim the code so only the first caller can use it.
  const count = await db.incrObjectField(key, 'consumed');
  if (count > 1) {
    return null;
  }

  const record = await db.getObject(key);
  if (!record) return null;
  if (!record.payload || Date.now() > record.exp) {
    await db.delete(key);
    return null;
  }
  // Single-use: consume immediately
  await db.delete(key);
  return record.payload;
}

function matchesSignature(actualValue, expectedValue) {
  const actualBuffer = Buffer.from(String(actualValue ?? ''));
  const expectedBuffer = Buffer.from(String(expectedValue ?? ''));

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function sanitizeClientRedirectTarget(value, fallbackValue = `/${CITY_SLUG}`) {
  const trimmedValue = String(value ?? '').trim();
  if (!trimmedValue || !trimmedValue.startsWith('/') || trimmedValue.startsWith('//')) {
    return fallbackValue;
  }

  try {
    const parsedUrl = new URL(trimmedValue, 'http://localhost');
    const result = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    // Re-check the result: the parser turns `\` into `/`, so `/\evil.com` -> `//evil.com`.
    if (!result.startsWith('/') || result.startsWith('//')) {
      return fallbackValue;
    }
    return result;
  } catch {
    return fallbackValue;
  }
}

function parseForumSyncStateToken(token, allowedUrls) {
  if (!APP_SESSION_SECRET || !token) {
    return null;
  }

  const [encodedPayload, providedSignature, ...rest] = String(token).split('.');
  if (!encodedPayload || !providedSignature || rest.length > 0) {
    return null;
  }

  if (!matchesSignature(providedSignature, createSignature(encodedPayload))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (payload?.type !== 'forum-sync') {
      return null;
    }

    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return null;
    }

    const returnTo = String(payload.returnTo || '').trim();
    if (!returnTo) {
      return null;
    }

    const parsedReturnTo = new URL(returnTo);
    if (parsedReturnTo.protocol !== 'http:' && parsedReturnTo.protocol !== 'https:') {
      return null;
    }

    // Validate returnTo origin against the configured allowed URLs.
    const allowed = Array.isArray(allowedUrls)
      ? allowedUrls.map((u) => String(u ?? '').trim()).filter(Boolean)
      : [String(allowedUrls ?? '').trim()].filter(Boolean);

    if (allowed.length > 0 && !allowed.includes(parsedReturnTo.origin)) {
      return null;
    }

    return {
      returnTo: parsedReturnTo.toString(),
      redirectTo: sanitizeClientRedirectTarget(payload.redirectTo),
      mode: payload.mode === 'register' ? 'register' : 'login',
    };
  } catch {
    return null;
  }
}

async function resolveRoles(uid) {
  const { operatorGroups, palvelukarttaOperatorGroups, uutisetWriterGroups, eventMaintainerGroups, adminGroups } = getConfig();

  const roles = ['user'];

  for (const groupName of operatorGroups) {
    if (await groups.isMember(uid, groupName)) {
      roles.push('operator');
      break;
    }
  }

  for (const groupName of palvelukarttaOperatorGroups) {
    if (await groups.isMember(uid, groupName)) {
      roles.push('palvelukartta-operator');
      break;
    }
  }

  for (const groupName of uutisetWriterGroups) {
    if (await groups.isMember(uid, groupName)) {
      roles.push('writer');
      break;
    }
  }

  for (const groupName of eventMaintainerGroups) {
    if (await groups.isMember(uid, groupName)) {
      roles.push('event-maintainer');
      break;
    }
  }

  for (const groupName of adminGroups) {
    if (await groups.isMember(uid, groupName)) {
      roles.push('admin');
      break;
    }
  }

  return roles;
}

/**
 * Verify the actor belongs to at least one configured uutiset (news) writer
 * group. Mirrors services.assertPalvelukarttaOperator but checks
 * uutisetWriterGroups.
 */
async function assertUutisetWriter(actorUid) {
  const { uutisetWriterGroups } = getConfig();
  for (const groupName of uutisetWriterGroups) {
    const isMember = await groups.isMember(actorUid, groupName);
    if (isMember) {
      return;
    }
  }

  throw errors.forbidden('News writer access is required.');
}

/**
 * Verify the actor belongs to at least one configured event maintainer
 * group (tapahtumakalenterin ylläpitäjät).
 */
async function assertEventMaintainer(actorUid) {
  const { eventMaintainerGroups } = getConfig();
  for (const groupName of eventMaintainerGroups) {
    const isMember = await groups.isMember(actorUid, groupName);
    if (isMember) {
      return;
    }
  }

  throw errors.forbidden('Event maintainer access is required.');
}

async function buildAppAuthPayload(uid) {
  const fields = await user.getUserFields(uid, [
    'uid',
    'username',
    'displayname',
    'userslug',
    'picture',
    'uploadedpicture',
  ]);

  const resolvedUid = String(fields?.uid ?? uid ?? '').trim();
  if (!resolvedUid) {
    throw errors.unauthorized('Forum login is required.');
  }

  const displayName = String(fields?.displayname || fields?.username || '').trim();
  const username = String(fields?.username || displayName || '').trim();
  const userslug = String(fields?.userslug || '').trim();
  const picture = String(fields?.picture || fields?.uploadedpicture || '').trim() || null;
  const roles = await resolveRoles(resolvedUid);

  return {
    session: {
      source: 'nodebb',
      user: {
        id: resolvedUid,
        username,
        displayname: displayName,
        userslug,
        picture,
      },
    },
    profile: {
      id: resolvedUid,
      nodebb_uid: Number.parseInt(resolvedUid, 10) || null,
      username,
      roles,
      city_slug: CITY_SLUG,
      city_id: null,
      picture,
      userslug,
    },
  };
}

function createAppSessionToken(authPayload) {
  if (!APP_SESSION_SECRET) {
    throw errors.serviceUnavailable('APP_SESSION_SECRET is not configured.');
  }

  const now = Date.now();
  const encodedPayload = Buffer.from(JSON.stringify({
    ...authPayload,
    iat: now,
    exp: now + APP_SESSION_TTL_SECONDS * 1000,
  })).toString('base64url');

  return `${encodedPayload}.${createSignature(encodedPayload)}`;
}

function getLoginRedirectPath(mode) {
  const relativePath = String(nconf.get('relative_path') || '').trim().replace(/\/$/, '');
  const authPath = mode === 'register' ? '/register' : '/login';
  return `${relativePath}${authPath}` || authPath;
}

function buildAuthenticatedRedirectUrl({ returnTo, redirectTo, exchangeCode }) {
  const destinationUrl = new URL(returnTo);

  if (exchangeCode) {
    destinationUrl.searchParams.set('code', exchangeCode);
  }

  destinationUrl.searchParams.set('redirectTo', redirectTo);

  return destinationUrl.toString();
}

async function saveSession(req) {
  if (!req.session || typeof req.session.save !== 'function') {
    return;
  }

  await new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

async function persistCurrentUrlAsReturnTo(req) {
  if (!req.session) {
    return;
  }

  req.session.returnTo = req.originalUrl;
  await saveSession(req);
}

async function clearReturnTo(req) {
  if (!req.session || !req.session.returnTo) {
    return;
  }

  delete req.session.returnTo;
  await saveSession(req);
}

// --- Token Deny List ---

const REVOKE_KEY = (sig) => `havaintokartta:revoke:${createRevocationHash(sig)}`;

function createRevocationHash(sig) {
  // SHA-256 hash of the signature for consistent Redis key length (64 hex chars)
  return createHash('sha256').update(sig).digest('hex');
}

function parseTokenForRevocation(token) {
  // Extract signature and remaining TTL from a full token.
  // Returns { signature, remainingTtlSeconds } or null if token is malformed.
  const [encodedPayload, signature, ...rest] = String(token).split('.');
  if (!encodedPayload || !signature || rest.length > 0) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    // Guard: exp must be a finite number. Non-numeric exp (string, boolean, etc.)
    // would produce NaN in arithmetic, causing db.expire to fail.
    if (typeof payload?.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return null;
    }
    const remainingMs = payload.exp - Date.now();
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return { signature, remainingTtlSeconds: remainingSeconds };
  } catch {
    return null;
  }
}

async function revokeTokenSignature(tokenSignature, ttlSeconds) {
  const key = REVOKE_KEY(tokenSignature);
  // TTL = remaining token life, or default to max session TTL if unknown
  const expire = ttlSeconds || APP_SESSION_TTL_SECONDS;
  await db.set(key, '1');
  await db.expire(key, expire);
}

async function isTokenSignatureRevoked(tokenSignature) {
  const key = REVOKE_KEY(tokenSignature);
  const exists = await db.exists(key);
  return Boolean(exists);
}

module.exports = {
  APP_SESSION_TTL_SECONDS,
  assertEventMaintainer,
  assertUutisetWriter,
  buildAppAuthPayload,
  buildAuthenticatedRedirectUrl,
  clearReturnTo,
  createAppSessionToken,
  createExchangeCode,
  getLoginRedirectPath,
  isTokenSignatureRevoked,
  parseForumSyncStateToken,
  parseTokenForRevocation,
  persistCurrentUrlAsReturnTo,
  resolveRoles,
  retrieveAndConsumeExchangeCode,
  revokeTokenSignature,
  storeExchangeCode,
};