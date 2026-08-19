'use strict';

const { randomUUID } = require('node:crypto');

const { db, groups } = require('./nodebb');
const errors = require('./errors');
const { getConfig } = require('./config');
const { deleteServiceImage } = require('./upload');
const { sanitizeSingleLineText, sanitizeMultilineText, toBoolean, toNullableString } = require('./utils');

const KEYS = {
  allServices: 'palvelukartta:services:all',
  service(serviceId) {
    return `palvelukartta:service:${serviceId}`;
  },
  categoryServices(category) {
    return `palvelukartta:services:category:${category}`;
  },
  slugIndex(slug) {
    return `palvelukartta:slug:${slug}`;
  },
};

/**
 * Generate a URL-friendly slug from Finnish text.
 * Normalizes ä→a, ö→o, lowercases, replaces spaces/special chars with hyphens.
 */
function slugify(text) {
  if (!text) return '';
  return String(text)
    .replace(/^#+\s*/, '')       // strip markdown heading prefixes
    .replace(/ä|Ä/g, 'a')
    .replace(/ö|Ö/g, 'o')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // remove special chars
    .replace(/[\s_]+/g, '-')      // spaces/underscores → hyphens
    .replace(/-+/g, '-')          // collapse multiple hyphens
    .replace(/^-+|-+$/g, '')      // trim leading/trailing hyphens
    .slice(0, 100);               // cap length
}

/**
 * Find a unique slug: if baseSlug is taken, append -2, -3, etc.
 */
async function findUniqueSlug(baseSlug, exceptServiceId) {
  if (!baseSlug) return '';
  // Check if the base slug is already taken (by a different service)
  const existingId = await db.get(KEYS.slugIndex(baseSlug));
  if (!existingId || existingId === String(exceptServiceId)) {
    return baseSlug;
  }
  // Collision — try baseSlug-2, baseSlug-3, ...
  for (let i = 2; i <= 100; i++) {
    const candidate = `${baseSlug}-${i}`;
    const takenId = await db.get(KEYS.slugIndex(candidate));
    if (!takenId || takenId === String(exceptServiceId)) {
      return candidate;
    }
  }
  // Fallback: should never happen in practice
  return `${baseSlug}-${Date.now()}`;
}

const VALID_CATEGORIES = new Set([
  'luontopolku',
  'nähtävyys',
  'grillipaikka',
  'leikkipaikka',
  'urheilu',
  'julkiset',
  'vesisto',
  'pysakointi',
]);

const CATEGORY_LABELS = {
  luontopolku: 'Ladut ja luontopolut',
  'nähtävyys': 'Nähtävyydet',
  grillipaikka: 'Nuotiopaikat ja laavut',
  leikkipaikka: 'Leikkipaikka',
  urheilu: 'Liikunta',
  julkiset: 'Julkiset palvelut',
  vesisto: 'Uimapaikat',
  pysakointi: 'Pysäköinti',
};

/**
 * Normalize Finnish text: replace ä→a, ö→o for fuzzy matching.
 */
function normalizeFinnish(text) {
  return text
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/Ä/g, 'A')
    .replace(/Ö/g, 'O');
}

/**
 * Fuzzy match: checks if any query word matches as a substring or prefix
 * of any word in the target text. Both are normalized (Finnish chars, lowercase).
 */
function fuzzyMatch(query, target) {
  const normalizedQuery = normalizeFinnish(query).toLowerCase();
  const normalizedTarget = normalizeFinnish(target).toLowerCase();
  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
  const targetWords = normalizedTarget.split(/\s+/).filter(Boolean);

  return queryWords.every((qWord) => {
    // Direct substring match
    if (normalizedTarget.includes(qWord)) return true;
    // Prefix match: query word matches the start of any target word
    return targetWords.some((tWord) => tWord.startsWith(qWord));
  });
}

const VALID_GEOMETRY_TYPES = new Set(['Point', 'LineString', 'MultiLineString', 'Polygon']);

/**
 * Normalize routes: accept a single route object (legacy) or an array of routes.
 * Returns an array of validated LineString objects.
 */
function normalizeRoutes(input) {
  if (!input) return [];
  // Legacy: single route object
  if (!Array.isArray(input) && typeof input === 'object' && input.type === 'LineString') {
    return [input];
  }
  // New: array of routes
  if (Array.isArray(input)) {
    return input.filter((r) => r && typeof r === 'object' && r.type === 'LineString');
  }
  return [];
}

/**
 * Normalize parking spots: accept a single Point object (legacy) or an array of Points.
 * Returns an array of Point objects.
 */
function normalizeParkingSpots(input) {
  if (!input) return [];
  // Legacy: single Point object
  if (!Array.isArray(input) && typeof input === 'object' && input.type === 'Point') {
    return [input];
  }
  // New: array of Points
  if (Array.isArray(input)) {
    return input.filter((p) => p && typeof p === 'object' && p.type === 'Point');
  }
  return [];
}

function normalizeHeittopaikat(input) {
  if (!input) return [];
  if (!Array.isArray(input)) return [];
  return input.filter((h) => h && typeof h === 'object' && h.type === 'Point' && h.coordinates);
}

function normalizeKorit(input) {
  if (!input) return [];
  if (!Array.isArray(input)) return [];
  return input.filter((k) => k && typeof k === 'object' && k.type === 'Point' && k.coordinates);
}

/**
 * Normalize images: accept legacy string[] or new object[] with url, caption, location.
 * Returns an array of normalized image objects.
 */
function normalizeImages(input) {
  if (!input) return [];
  if (!Array.isArray(input)) return [];
  return input.map((img) => {
    // Legacy: plain string URL
    if (typeof img === 'string') {
      return { url: img };
    }
    // New: object with url (and optional caption, location)
    if (img && typeof img === 'object' && img.url) {
      const result = { url: img.url };
      if (img.caption) result.caption = String(img.caption);
      if (img.location && typeof img.location === 'object') {
        const lat = Number(img.location.lat);
        const lng = Number(img.location.lng);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          result.location = { lat, lng };
          if (typeof img.location.heading === 'number') {
            const heading = img.location.heading % 360;
            result.location.heading = heading < 0 ? heading + 360 : heading;
          }
        }
      }
      return result;
    }
    return null;
  }).filter(Boolean);
}

// ── Serialization ──────────────────────────────────────────────

function serializeService(service) {
  // Normalize: always store as routes array
  const routes = normalizeRoutes(service.routes || service.route);
  const images = normalizeImages(service.images);
  return {
    id: String(service.id),
    name: String(service.name ?? ''),
    nameEn: String(service.nameEn ?? ''),
    description: String(service.description ?? ''),
    shortDescription: String(service.shortDescription ?? ''),
    category: String(service.category ?? ''),
    subcategory: String(service.subcategory ?? ''),
    geometry: JSON.stringify(service.geometry || {}),
    routes: JSON.stringify(routes),
    parkingSpots: JSON.stringify(normalizeParkingSpots(service.parkingSpots || service.parkingSpot)),
    heittopaikat: JSON.stringify(normalizeHeittopaikat(service.heittopaikat)),
    korit: JSON.stringify(normalizeKorit(service.korit)),
    geometryColor: String(service.geometryColor || ''),
    routeColor: String(service.routeColor || ''),
    address: String(service.address ?? ''),
    admin: String(service.admin ?? ''),
    openingHours: String(service.openingHours ?? ''),
    contact: String(service.contact ?? ''),
    url: String(service.url ?? ''),
    tags: Array.isArray(service.tags) ? JSON.stringify(service.tags) : '[]',
    images: JSON.stringify(images),
    subIconId: String(service.subIconId ?? ''),
    firewood: toBoolean(service.firewood) ? '1' : '0',
    hasTrashBin: toBoolean(service.hasTrashBin) ? '1' : '0',
    isPaid: toBoolean(service.isPaid) ? '1' : '0',
    isPublic: service.isPublic === false ? '0' : '1',
    slug: String(service.slug ?? ''),
    sortOrder: String(service.sortOrder ?? 0),
    createdAt: String(service.createdAt ?? ''),
    updatedAt: String(service.updatedAt ?? ''),
    createdByUid: String(service.createdByUid ?? ''),
  };
}

function deserializeService(value) {
  if (!value || typeof value !== 'object' || !value.id) {
    return null;
  }

  let geometry = {};
  try {
    geometry = JSON.parse(value.geometry || '{}');
  } catch { /* keep empty */ }

  // Support both old `route` (single object) and new `routes` (array)
  let routes = [];
  if (value.routes) {
    try {
      const parsed = JSON.parse(value.routes);
      routes = normalizeRoutes(parsed);
    } catch { /* keep empty */ }
  } else if (value.route) {
    try {
      const parsed = JSON.parse(value.route);
      routes = normalizeRoutes(parsed);
    } catch { /* keep empty */ }
  }

  // Parking spots — support both old single parkingSpot and new parkingSpots array
  let parkingSpots = [];
  if (value.parkingSpots) {
    try {
      const parsed = JSON.parse(value.parkingSpots);
      parkingSpots = normalizeParkingSpots(parsed);
    } catch { /* keep empty */ }
  } else if (value.parkingSpot) {
    try {
      const parsed = JSON.parse(value.parkingSpot);
      parkingSpots = normalizeParkingSpots(parsed);
    } catch { /* keep empty */ }
  }

  // Heittopaikat (dumping points)
  let heittopaikat = [];
  if (value.heittopaikat) {
    try {
      const parsed = JSON.parse(value.heittopaikat);
      heittopaikat = normalizeHeittopaikat(parsed);
    } catch { /* keep empty */ }
  }

  // Korit (baskets)
  let korit = [];
  if (value.korit) {
    try {
      const parsed = JSON.parse(value.korit);
      korit = normalizeKorit(parsed);
    } catch { /* keep empty */ }
  }

  let tags = [];
  try {
    tags = JSON.parse(value.tags || '[]');
  } catch { /* keep empty */ }

  let images = [];
  try {
    const parsed = JSON.parse(value.images || '[]');
    images = normalizeImages(parsed);
  } catch { /* keep empty */ }

  return {
    id: String(value.id),
    name: String(value.name || ''),
    nameEn: String(value.nameEn || ''),
    description: String(value.description || ''),
    shortDescription: String(value.shortDescription || ''),
    category: String(value.category || ''),
    subcategory: String(value.subcategory || ''),
    geometry,
    routes,
    parkingSpots,
    heittopaikat,
    korit,
    geometryColor: String(value.geometryColor || ''),
    routeColor: String(value.routeColor || ''),
    address: String(value.address || ''),
    admin: String(value.admin || ''),
    openingHours: String(value.openingHours || ''),
    contact: String(value.contact || ''),
    url: String(value.url || ''),
    tags,
    images,
    subIconId: String(value.subIconId || ''),
    firewood: toBoolean(value.firewood),
    hasTrashBin: toBoolean(value.hasTrashBin),
    isPaid: toBoolean(value.isPaid),
    slug: String(value.slug || ''),
    isPublic: value.isPublic === undefined ? true : toBoolean(value.isPublic),
    sortOrder: Number(value.sortOrder) || 0,
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || ''),
    createdByUid: String(value.createdByUid || ''),
  };
}

// ── Helpers ────────────────────────────────────────────────────

function getScore(service) {
  const timestamp = Date.parse(service.updatedAt || service.createdAt || '') || Date.now();
  return timestamp;
}

function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') {
    throw errors.badRequest('geometry is required and must be an object.');
  }

  if (!VALID_GEOMETRY_TYPES.has(geometry.type)) {
    throw errors.badRequest(`geometry.type must be one of: ${[...VALID_GEOMETRY_TYPES].join(', ')}.`);
  }

  if (!Array.isArray(geometry.coordinates)) {
    throw errors.badRequest('geometry.coordinates must be an array.');
  }

  // Basic coordinate validation
  if (geometry.type === 'Point' && geometry.coordinates.length < 2) {
    throw errors.badRequest('Point coordinates must have at least [lng, lat].');
  }

  if ((geometry.type === 'LineString' || geometry.type === 'Polygon') && geometry.coordinates.length === 0) {
    throw errors.badRequest(`${geometry.type} coordinates must not be empty.`);
  }

  if (geometry.type === 'MultiLineString' && geometry.coordinates.length === 0) {
    throw errors.badRequest('MultiLineString coordinates must not be empty.');
  }

  // Validate coordinate bounds
  const validateCoordPair = (pair, path) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      throw errors.badRequest(`${path} must be [lng, lat] array.`);
    }
    const [lng, lat] = pair;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw errors.badRequest(`${path} must contain numbers.`);
    }
    if (lat < -90 || lat > 90) {
      throw errors.badRequest(`${path} latitude must be between -90 and 90.`);
    }
    if (lng < -180 || lng > 180) {
      throw errors.badRequest(`${path} longitude must be between -180 and 180.`);
    }
  };

  if (geometry.type === 'Point') {
    validateCoordPair(geometry.coordinates, 'geometry.coordinates');
  } else if (geometry.type === 'MultiLineString') {
    // MultiLineString: array of LineStrings, each is array of [lng, lat]
    geometry.coordinates.forEach((line, i) => {
      if (!Array.isArray(line)) {
        throw errors.badRequest(`geometry.coordinates[${i}] must be an array of [lng, lat].`);
      }
      line.forEach((pair, j) => {
        validateCoordPair(pair, `geometry.coordinates[${i}][${j}]`);
      });
    });
  } else {
    geometry.coordinates.forEach((pair, i) => {
      validateCoordPair(pair, `geometry.coordinates[${i}]`);
    });
  }

  return geometry;
}

function validateRoute(route) {
  if (!route || typeof route !== 'object') return null;
  if (route.type !== 'LineString') {
    throw errors.badRequest('route.type must be LineString.');
  }
  if (!Array.isArray(route.coordinates) || route.coordinates.length < 2) {
    throw errors.badRequest('route.coordinates must have at least 2 points.');
  }
  route.coordinates.forEach((pair, i) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      throw errors.badRequest(`route.coordinates[${i}] must be [lng, lat] array.`);
    }
    const [lng, lat] = pair;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw errors.badRequest(`route.coordinates[${i}] must contain numbers.`);
    }
    if (lat < -90 || lat > 90) {
      throw errors.badRequest(`route.coordinates[${i}] latitude must be between -90 and 90.`);
    }
    if (lng < -180 || lng > 180) {
      throw errors.badRequest(`route.coordinates[${i}] longitude must be between -180 and 180.`);
    }
  });
  return route;
}

/**
 * Validate routes: accept a single route object (legacy) or an array of routes.
 * Returns an array of validated LineString objects.
 */
function validateRoutes(input) {
  if (!input) return [];
  // Legacy: single route object
  if (!Array.isArray(input)) {
    const validated = validateRoute(input);
    return validated ? [validated] : [];
  }
  // Array of routes
  const validated = [];
  for (let i = 0; i < input.length; i++) {
    const r = validateRoute(input[i]);
    if (r) validated.push(r);
  }
  return validated;
}

function validateColor(value) {
  if (!value || typeof value !== 'string') return '';
  if (/^#[0-9A-Fa-f]{6}$/.test(value)) return value;
  throw errors.badRequest('color must be a valid hex color (e.g. #3b82f6).');
}

function validateParkingSpot(value) {
  if (!value) return null;
  if (typeof value !== 'object') {
    throw errors.badRequest('parkingSpot must be a GeoJSON Point object or null.');
  }
  if (value.type !== 'Point') {
    throw errors.badRequest('parkingSpot.type must be "Point".');
  }
  if (!Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    throw errors.badRequest('parkingSpot.coordinates must be [lng, lat] array.');
  }
  const [lng, lat] = value.coordinates;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw errors.badRequest('parkingSpot.coordinates must contain numbers.');
  }
  if (lat < -90 || lat > 90) {
    throw errors.badRequest('parkingSpot.coordinates latitude must be between -90 and 90.');
  }
  if (lng < -180 || lng > 180) {
    throw errors.badRequest('parkingSpot.coordinates longitude must be between -180 and 180.');
  }
  return { type: 'Point', coordinates: [lng, lat] };
}

function validateParkingSpots(value) {
  if (!value) return [];
  // Support legacy single Point
  if (!Array.isArray(value) && typeof value === 'object') {
    return [validateParkingSpot(value)];
  }
  if (!Array.isArray(value)) {
    throw errors.badRequest('parkingSpots must be an array of GeoJSON Point objects.');
  }
  const validated = [];
  for (let i = 0; i < value.length; i++) {
    const p = validateParkingSpot(value[i]);
    if (p) validated.push(p);
  }
  return validated;
}

// ── Heittopaikka validation ───────────────────────────────────

function validateHeittopaikka(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type !== 'Point') {
    throw errors.badRequest('heittopaikka.type must be "Point".');
  }
  if (!Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    throw errors.badRequest('heittopaikka.coordinates must be [lng, lat] array.');
  }
  const [lng, lat] = value.coordinates;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw errors.badRequest('heittopaikka.coordinates must contain numbers.');
  }
  if (lat < -90 || lat > 90) {
    throw errors.badRequest('heittopaikka.coordinates latitude must be between -90 and 90.');
  }
  if (lng < -180 || lng > 180) {
    throw errors.badRequest('heittopaikka.coordinates longitude must be between -180 and 180.');
  }
  const result = { type: 'Point', coordinates: [lng, lat] };
  if (typeof value.rotation === 'number') result.rotation = value.rotation;
  if (typeof value.text === 'string' && value.text.length <= 20) result.text = value.text;
  if (typeof value.iconScale === 'number' && value.iconScale >= 0.5 && value.iconScale <= 2) result.iconScale = value.iconScale;
  if (typeof value.fixedSize === 'boolean') result.fixedSize = value.fixedSize;
  if (typeof value.baseZoom === 'number') result.baseZoom = value.baseZoom;
  return result;
}

function validateHeittopaikat(value) {
  if (!value) return [];
  if (!Array.isArray(value)) {
    throw errors.badRequest('heittopaikat must be an array of GeoJSON Point objects.');
  }
  const validated = [];
  for (let i = 0; i < value.length; i++) {
    const h = validateHeittopaikka(value[i]);
    if (h) validated.push(h);
  }
  return validated;
}

function validateKori(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type !== 'Point') {
    throw errors.badRequest('kori.type must be "Point".');
  }
  if (!Array.isArray(value.coordinates) || value.coordinates.length < 2) {
    throw errors.badRequest('kori.coordinates must be [lng, lat] array.');
  }
  const [lng, lat] = value.coordinates;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw errors.badRequest('kori.coordinates must contain numbers.');
  }
  if (lat < -90 || lat > 90) {
    throw errors.badRequest('kori.coordinates latitude must be between -90 and 90.');
  }
  if (lng < -180 || lng > 180) {
    throw errors.badRequest('kori.coordinates longitude must be between -180 and 180.');
  }
  const result = { type: 'Point', coordinates: [lng, lat] };
  if (typeof value.iconScale === 'number' && value.iconScale >= 0.5 && value.iconScale <= 2) result.iconScale = value.iconScale;
  if (typeof value.fixedSize === 'boolean') result.fixedSize = value.fixedSize;
  if (typeof value.baseZoom === 'number') result.baseZoom = value.baseZoom;
  if (typeof value.text === 'string' && value.text.length <= 20) result.text = value.text;
  return result;
}

function validateKorit(value) {
  if (!value) return [];
  if (!Array.isArray(value)) {
    throw errors.badRequest('korit must be an array of GeoJSON Point objects.');
  }
  const validated = [];
  for (let i = 0; i < value.length; i++) {
    const k = validateKori(value[i]);
    if (k) validated.push(k);
  }
  return validated;
}

function validateUrl(value) {
  const urlValue = sanitizeSingleLineText(value, 500) || '';
  if (!urlValue) return '';
  try {
    new URL(urlValue); // eslint-disable-line no-new
  } catch {
    throw errors.badRequest('url must be a valid URL.');
  }
  return urlValue;
}

function validateImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validate an image entry (string URL or object with url + optional caption/location).
 * Returns the normalized image object or null if invalid.
 */
function validateImageEntry(img) {
  // Legacy: plain string URL
  if (typeof img === 'string') {
    return validateImageUrl(img) ? { url: img } : null;
  }
  // New: object format
  if (img && typeof img === 'object') {
    if (!validateImageUrl(img.url)) return null;
    const result = { url: img.url };
    if (img.caption) result.caption = sanitizeSingleLineText(img.caption, 500);
    if (img.location && typeof img.location === 'object') {
      const lat = Number(img.location.lat);
      const lng = Number(img.location.lng);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        result.location = { lat, lng };
        if (typeof img.location.heading === 'number') {
          const heading = img.location.heading % 360;
          result.location.heading = heading < 0 ? heading + 360 : heading;
        }
      }
    }
    return result;
  }
  return null;
}

/**
 * Validate images array: accepts string[] (legacy) or object[] (new format).
 * Returns an array of validated image objects.
 */
function validateImages(input) {
  if (!input) return [];
  if (!Array.isArray(input)) return [];
  return input.map(validateImageEntry).filter(Boolean);
}

// ── CRUD ───────────────────────────────────────────────────────

async function saveService(service) {
  const score = getScore(service);
  const serviceKey = KEYS.service(service.id);

  // Each db call commits its own transaction, so we track what succeeded
  // and roll back in reverse order if anything fails.
  const done = [];

  try {
    await db.setObject(serviceKey, serializeService(service));
    done.push({ key: serviceKey, remove: () => db.delete(serviceKey) });

    await db.sortedSetAdd(KEYS.allServices, score, service.id);
    done.push({ key: KEYS.allServices, remove: () => db.sortedSetRemove(KEYS.allServices, service.id) });

    // Category index
    if (service.category) {
      const catKey = KEYS.categoryServices(service.category);
      await db.sortedSetAdd(catKey, score, service.id);
      done.push({ key: catKey, remove: () => db.sortedSetRemove(catKey, service.id) });
    }

    // Slug index — write reverse lookup (slug → serviceId)
    if (service.slug) {
      await db.set(KEYS.slugIndex(service.slug), service.id);
      done.push({ key: KEYS.slugIndex(service.slug), remove: () => db.delete(KEYS.slugIndex(service.slug)) });
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

  return service;
}

async function getServiceBySlug(slug) {
  const serviceId = await db.get(KEYS.slugIndex(slug));
  if (!serviceId) return null;
  return getService(serviceId);
}

async function getService(serviceId) {
  return deserializeService(await db.getObject(KEYS.service(serviceId)));
}

async function getServices(serviceIds, { includePrivate = false } = {}) {
  const services = (await Promise.all(serviceIds.map((id) => getService(id)))).filter(Boolean);
  return includePrivate ? services : services.filter((s) => s.isPublic !== false);
}

async function listServiceIds(key) {
  return db.getSortedSetRevRange(key, 0, -1);
}

async function listAllServices({ includePrivate = false } = {}) {
  return getServices(await listServiceIds(KEYS.allServices), { includePrivate });
}

async function listServicesByCategory(category, { includePrivate = false } = {}) {
  return getServices(await listServiceIds(KEYS.categoryServices(category)), { includePrivate });
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Verify the actor belongs to at least one configured Palvelukartta operator
 * group. Mirrors reports.assertOperator but checks palvelukarttaOperatorGroups.
 */
async function assertPalvelukarttaOperator(actorUid) {
  const { palvelukarttaOperatorGroups } = getConfig();
  for (const groupName of palvelukarttaOperatorGroups) {
    const isMember = await groups.isMember(actorUid, groupName);
    if (isMember) {
      return;
    }
  }

  throw errors.forbidden('Palvelukartta operator access is required.');
}

/**
 * Create a new service.
 */
async function createService(payload, actorUid) {
  const normalizedActorUid = sanitizeSingleLineText(actorUid, 80);
  if (!normalizedActorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  await assertPalvelukarttaOperator(normalizedActorUid);

  const name = sanitizeSingleLineText(payload?.name, 200);
  if (!name) {
    throw errors.badRequest('name is required.');
  }

  const category = sanitizeSingleLineText(payload?.category, 50).toLowerCase();
  if (!VALID_CATEGORIES.has(category)) {
    throw errors.badRequest(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}.`);
  }

  const geometry = validateGeometry(payload?.geometry);

  // Generate slug from name
  const baseSlug = slugify(name);
  const serviceSlug = await findUniqueSlug(baseSlug, undefined);

  const now = new Date().toISOString();
  const service = {
    id: randomUUID(),
    slug: serviceSlug,
    name,
    nameEn: sanitizeSingleLineText(payload?.nameEn, 200) || '',
    description: sanitizeMultilineText(payload?.description, 5000) || '',
    shortDescription: sanitizeSingleLineText(payload?.shortDescription, 500) || '',
    category,
    subcategory: sanitizeSingleLineText(payload?.subcategory, 100) || '',
    geometry,
    address: sanitizeSingleLineText(payload?.address, 200) || '',
    admin: sanitizeSingleLineText(payload?.admin, 200) || '',
    openingHours: sanitizeSingleLineText(payload?.openingHours, 200) || '',
    contact: sanitizeSingleLineText(payload?.contact, 200) || '',
    url: validateUrl(payload?.url) || '',
    tags: Array.isArray(payload?.tags)
      ? payload.tags.map((t) => sanitizeSingleLineText(t, 50)).filter(Boolean)
      : [],
    images: validateImages(payload?.images),
    subIconId: sanitizeSingleLineText(payload?.subIconId, 100) || '',
    routes: validateRoutes(payload?.routes || payload?.route),
    parkingSpots: validateParkingSpots(payload?.parkingSpots || payload?.parkingSpot),
    heittopaikat: validateHeittopaikat(payload?.heittopaikat),
    korit: validateKorit(payload?.korit),
    geometryColor: validateColor(payload?.geometryColor) || '',
    routeColor: validateColor(payload?.routeColor) || '',
    firewood: toBoolean(payload?.firewood),
    hasTrashBin: toBoolean(payload?.hasTrashBin),
    isPaid: toBoolean(payload?.isPaid),
    isPublic: payload?.isPublic === undefined ? true : toBoolean(payload.isPublic),
    sortOrder: Number(payload?.sortOrder) || 0,
    createdAt: now,
    updatedAt: now,
    createdByUid: String(actorUid || ''),
  };

  return saveService(service);
}

/**
 * Update an existing service.
 */
async function updateService(serviceId, payload, actorUid) {
  const normalizedActorUid = sanitizeSingleLineText(actorUid, 80);
  if (!normalizedActorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  await assertPalvelukarttaOperator(normalizedActorUid);

  const existing = await getService(serviceId);
  if (!existing) {
    throw errors.notFound('Service not found.');
  }

  // Build updated object — only overwrite fields that are provided
  const updated = { ...existing };

  if (payload?.name !== undefined) {
    const newName = sanitizeSingleLineText(payload.name, 200) || existing.name;
    updated.name = newName;

    // Regenerate slug if name changed
    const newSlug = slugify(newName);
    if (newSlug && newSlug !== existing.slug) {
      // Remove old slug index entry
      if (existing.slug) {
        await db.delete(KEYS.slugIndex(existing.slug));
      }
      updated.slug = await findUniqueSlug(newSlug, serviceId);
    }
  }
  if (payload?.nameEn !== undefined) {
    updated.nameEn = sanitizeSingleLineText(payload.nameEn, 200) || '';
  }
  if (payload?.description !== undefined) {
    updated.description = sanitizeMultilineText(payload.description, 5000) || '';
  }
  if (payload?.shortDescription !== undefined) {
    updated.shortDescription = sanitizeSingleLineText(payload.shortDescription, 500) || '';
  }
  if (payload?.category !== undefined) {
    const cat = sanitizeSingleLineText(payload.category, 50).toLowerCase();
    if (!VALID_CATEGORIES.has(cat)) {
      throw errors.badRequest(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}.`);
    }
    // Remove from old category index before changing
    if (existing.category && existing.category !== cat) {
      await db.sortedSetRemove(KEYS.categoryServices(existing.category), serviceId);
    }
    updated.category = cat;
  }
  if (payload?.subcategory !== undefined) {
    updated.subcategory = sanitizeSingleLineText(payload.subcategory, 100) || '';
  }
  if (payload?.geometry !== undefined) {
    updated.geometry = validateGeometry(payload.geometry);
  }
  if (payload?.address !== undefined) {
    updated.address = sanitizeSingleLineText(payload.address, 200) || '';
  }
  if (payload?.admin !== undefined) {
    updated.admin = sanitizeSingleLineText(payload.admin, 200) || '';
  }
  if (payload?.openingHours !== undefined) {
    updated.openingHours = sanitizeSingleLineText(payload.openingHours, 200) || '';
  }
  if (payload?.contact !== undefined) {
    updated.contact = sanitizeSingleLineText(payload.contact, 200) || '';
  }
  if (payload?.url !== undefined) {
    updated.url = validateUrl(payload.url) || '';
  }
  if (payload?.tags !== undefined) {
    updated.tags = Array.isArray(payload.tags)
      ? payload.tags.map((t) => sanitizeSingleLineText(t, 50)).filter(Boolean)
      : [];
  }
  if (payload?.images !== undefined) {
    updated.images = validateImages(payload.images);
  }
  if (payload?.subIconId !== undefined) {
    updated.subIconId = sanitizeSingleLineText(payload.subIconId, 100) || '';
  }
  if (payload?.routes !== undefined || payload?.route !== undefined) {
    updated.routes = validateRoutes(payload.routes || payload.route);
  }
  if (payload?.parkingSpots !== undefined || payload?.parkingSpot !== undefined) {
    updated.parkingSpots = validateParkingSpots(payload.parkingSpots || payload.parkingSpot);
  }
  if (payload?.heittopaikat !== undefined) {
    updated.heittopaikat = validateHeittopaikat(payload.heittopaikat);
  }
  if (payload?.korit !== undefined) {
    updated.korit = validateKorit(payload.korit);
  }
  if (payload?.geometryColor !== undefined) {
    updated.geometryColor = validateColor(payload.geometryColor) || '';
  }
  if (payload?.routeColor !== undefined) {
    updated.routeColor = validateColor(payload.routeColor) || '';
  }
  if (payload?.sortOrder !== undefined) {
    updated.sortOrder = Number(payload.sortOrder) || 0;
  }
  if (payload?.firewood !== undefined) {
    updated.firewood = toBoolean(payload.firewood);
  }
  if (payload?.hasTrashBin !== undefined) {
    updated.hasTrashBin = toBoolean(payload.hasTrashBin);
  }
  if (payload?.isPaid !== undefined) {
    updated.isPaid = toBoolean(payload.isPaid);
  }
  if (payload?.isPublic !== undefined) {
    updated.isPublic = toBoolean(payload.isPublic);
  }

  updated.updatedAt = new Date().toISOString();

  return saveService(updated);
}

/**
 * Delete a service and clean up associated image files.
 */
async function deleteService(serviceId, actorUid) {
  const normalizedActorUid = sanitizeSingleLineText(actorUid, 80);
  if (!normalizedActorUid) {
    throw errors.badRequest('actorUid is required.');
  }

  await assertPalvelukarttaOperator(normalizedActorUid);

  const service = await getService(serviceId);
  if (!service) {
    throw errors.notFound('Service not found.');
  }

  // Delete associated image files from filesystem (best-effort).
  // Images may be strings (legacy) or objects with .url property.
  if (Array.isArray(service.images) && service.images.length > 0) {
    await Promise.all(
      service.images.map((img) => {
        const imageUrl = typeof img === 'string' ? img : (img && img.url);
        return deleteServiceImage(imageUrl).catch((err) => {
          console.error('[palvelukartta] Image deletion failed:', err?.message || err);
        });
      })
    );
  }

  const safeId = String(service.id).trim();
  await db.delete(KEYS.service(safeId));
  await db.sortedSetRemove(KEYS.allServices, safeId);

  if (service.category) {
    await db.sortedSetRemove(KEYS.categoryServices(service.category), safeId);
  }

  // Clean up slug index
  if (service.slug) {
    await db.delete(KEYS.slugIndex(service.slug));
  }

  return service;
}

/**
 * Search services by query string and/or category filter.
 * Falls back to listing all services if no filters provided.
 */
async function searchServices({ query = '', categories = [], includePrivate = false } = {}) {
  const trimmedQuery = String(query).trim().toLowerCase();
  const categorySet = new Set(
    categories.map((c) => sanitizeSingleLineText(c, 50).toLowerCase()).filter(Boolean)
  );

  // If no filters, return all services
  if (!trimmedQuery && categorySet.size === 0) {
    return listAllServices({ includePrivate });
  }

  // If only categories, union the category indices
  if (!trimmedQuery && categorySet.size > 0) {
    const ids = new Set();
    for (const cat of categorySet) {
      const catIds = await listServiceIds(KEYS.categoryServices(cat));
      for (const id of catIds) ids.add(id);
    }
    return getServices([...ids], { includePrivate });
  }

  // Full-text search across all services (include private to search, then filter)
  const allServices = await listAllServices({ includePrivate: true });
  const matched = allServices.filter((s) => {
    // Filter non-public services unless includePrivate is set
    if (!includePrivate && s.isPublic === false) {
      return false;
    }
    // Category filter
    if (categorySet.size > 0 && !categorySet.has(s.category)) {
      return false;
    }

    // Text search across name, description, shortDescription, address, tags, category
    const searchable = [
      s.name,
      s.nameEn,
      s.description,
      s.shortDescription,
      s.address,
      s.subcategory,
      s.category,
      CATEGORY_LABELS[s.category],
      ...(s.tags || []),
    ]
      .filter(Boolean)
      .join(' ');

    return fuzzyMatch(trimmedQuery, searchable);
  });

  return matched;
}

module.exports = {
  assertPalvelukarttaOperator,
  createService,
  updateService,
  deleteService,
  getService,
  getServiceBySlug,
  getServices,
  listAllServices,
  listServicesByCategory,
  searchServices,
  slugify,
};
