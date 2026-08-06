'use strict';

const path = require('node:path');
const nconf = require.main.require('nconf');
const { parsePositiveInteger } = require('./utils');

function parseGroups(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

let cachedConfig = null;

function getConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  const uploadPath = String(nconf.get('upload_path') || path.join(process.cwd(), 'public', 'uploads'));
  const uploadUrl = String(nconf.get('upload_url') || '/assets/uploads').trim().replace(/\/$/, '');

  cachedConfig = {
    apiKey: String(process.env.NODEBB_API_KEY ?? '').trim(),
    categoryId: parsePositiveInteger(process.env.NODEBB_HAVAINTOKARTTA_CATEGORY_ID, 0),
    operatorGroups: parseGroups(process.env.NODEBB_OPERATOR_GROUPS || 'havaintokartta operaattori'),
    palvelukarttaOperatorGroups: parseGroups(process.env.PALVELUKARTTA_OPERATOR_GROUPS || 'palvelukartta'),
    uutisetWriterGroups: parseGroups(process.env.NODEBB_UUTISET_WRITER_GROUPS || 'toimittajat'),
    eventMaintainerGroups: parseGroups(process.env.NODEBB_EVENT_MAINTAINER_GROUPS || 'tapahtumakalenterin ylläpitäjät'),
    adminGroups: parseGroups(process.env.NODEBB_ADMIN_GROUPS || 'administrators'),
    baseUrl: String(nconf.get('url') || '').trim().replace(/\/$/, ''),
    appUrl: String(process.env.HAVAINTOKARTTA_APP_URL ?? '').trim().replace(/\/$/, ''),
    ylivieskahubUrl: String(process.env.YLIVIESKAHUB_URL ?? '').trim().replace(/\/$/, ''),
    palvelukarttaUrl: String(process.env.PALVELUKARTTA_APP_URL ?? '').trim().replace(/\/$/, ''),
    // Extra comma-separated origins allowed for SSO callback + CORS (e.g. local dev).
    // Example: NODEBB_ALLOWED_EXTRA_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
    extraAllowedOrigins: parseGroups(process.env.NODEBB_ALLOWED_EXTRA_ORIGINS || ''),
    uutisetCategoryId: parsePositiveInteger(process.env.NODEBB_UUTISET_CATEGORY_ID, 7),
    forumUrl: String(process.env.FORUM_URL ?? '').trim().replace(/\/$/, ''),
    uploadsDirectory: path.join(uploadPath, 'files', 'reports'),
    uploadsUrlPrefix: `${uploadUrl}/files/reports`,
    newsUploadsDirectory: path.join(uploadPath, 'files', 'news'),
    newsUploadsUrlPrefix: `${uploadUrl}/files/news`,
    eventUploadsDirectory: path.join(uploadPath, 'files', 'events'),
    eventUploadsUrlPrefix: `${uploadUrl}/files/events`,
    serviceUploadsDirectory: path.join(uploadPath, 'files', 'services'),
    serviceUploadsUrlPrefix: `${uploadUrl}/files/services`,
    maxUploadBytes: 10 * 1024 * 1024,
  };

  return cachedConfig;
}

function resetConfigCache() {
  cachedConfig = null;
}

module.exports = {
  getConfig,
  resetConfigCache,
};
