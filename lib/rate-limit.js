'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { keysMatch } = require('./auth');
const { getConfig } = require('./config');

const CONFIG = {
  public: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 120, // SessionSyncPoller polls every 15s = 60 req/15min; 120 allows 2 tabs + burst
  },
  apiWrite: {
    windowMs: 60 * 1000, // 1 minute
    max: 500, // 100 users × ~5 writes/min (create, review, mark done, etc.)
  },
  apiRead: {
    windowMs: 60 * 1000, // 1 minute
    max: 2000, // 100 users × ~15 reads/min (report list fetches per page load, single reports, images)
  },
};

function createLimiter(windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const apiKey = req.headers.authorization
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : null;

      // Only the API key once validated; otherwise fall back to the client IP.
      if (apiKey && keysMatch(apiKey, getConfig().apiKey)) {
        return apiKey;
      }

      return ipKeyGenerator(req);
    },
    handler: (req, res) => {
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    },
  });
}

function publicLimiter() {
  return createLimiter(CONFIG.public.windowMs, CONFIG.public.max);
}

function apiWriteLimiter() {
  return createLimiter(CONFIG.apiWrite.windowMs, CONFIG.apiWrite.max);
}

function apiReadLimiter() {
  return createLimiter(CONFIG.apiRead.windowMs, CONFIG.apiRead.max);
}

module.exports = {
  publicLimiter,
  apiWriteLimiter,
  apiReadLimiter,
};
