'use strict';

const { timingSafeEqual } = require('node:crypto');

const { getConfig } = require('./config');
const errors = require('./errors');

function extractBearerToken(headerValue) {
  const match = String(headerValue ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function keysMatch(a, b) {
  const bufferA = Buffer.from(String(a ?? ''));
  const bufferB = Buffer.from(String(b ?? ''));

  // Constant-time length check
  if (bufferA.length !== bufferB.length) {
    return false;
  }

  // Constant-time byte comparison
  return timingSafeEqual(bufferA, bufferB);
}

function requireApiKey(req, res, next) {
  const { apiKey } = getConfig();
  if (!apiKey) {
    next(errors.serviceUnavailable('NODEBB_API_KEY is not configured.'));
    return;
  }

  const token = extractBearerToken(req.headers.authorization);
  if (!token || !keysMatch(token, apiKey)) {
    next(errors.unauthorized('A valid API key is required.'));
    return;
  }

  next();
}

module.exports = {
  requireApiKey,
};
