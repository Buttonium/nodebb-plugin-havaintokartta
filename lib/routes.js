'use strict';

const express = require('express');

const { requireApiKey } = require('./auth');
const controllers = require('./controllers');
const { publicLimiter, apiWriteLimiter, apiReadLimiter } = require('./rate-limit');

function asyncRoute(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function errorHandler(err, req, res, next) {
  void next;

  const status = Number(err?.status) || 500;
  const message = err?.message || 'Unexpected error.';

  if (status >= 500) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[havaintokartta] Unhandled error:', err?.stack || err?.message || err);
    } else {
      console.error('[havaintokartta] Unhandled error:', message);
    }
  }

  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
}

function mount(parentRouter) {
  const router = express.Router();

  // Public endpoints — browser-facing, human-paced
  router.get('/auth/sync', publicLimiter(), asyncRoute(controllers.syncAuth));
  router.get('/auth/status', publicLimiter(), asyncRoute(controllers.checkForumLoginStatus));

  // API write endpoints — rate limiter BEFORE requireApiKey
  router.post('/auth/exchange', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.exchangeCode));
  router.post('/auth/revoke', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.revokeToken));
  router.post('/reports/upload', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.uploadReportImage));
  router.post('/news/upload', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.uploadNewsImage));
  router.post('/news/delete', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.deleteNewsImage));
  router.post('/events/upload', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.uploadEventImage));
  router.post('/events/delete', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.deleteEventImage));
  router.post('/reports', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.createReport));
  router.post('/reports/check-duplicate', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.checkDuplicateReport));
  router.post('/reports/:id/review', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.reviewReport));
  router.post('/reports/:id/done', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.markReportDone));
  router.delete('/reports/:id', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.deleteReport));

  // API read endpoints — rate limiter BEFORE requireApiKey
  router.post('/auth/verify', apiReadLimiter(), requireApiKey, asyncRoute(controllers.verifyToken));
  router.get('/reports/public', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getPublicReports));
  router.get('/reports/mine', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getMineReports));
  router.get('/reports/all', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getAllReports));
  router.get('/reports/actors', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getActors));
  router.get('/reports/stats', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getStats));
  router.get('/reports/:id', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getSingleReport));

  // Services (Palvelukartta) — write endpoints
  router.post('/services', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.createService));
  router.put('/services/:id', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.updateService));
  router.delete('/services/:id', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.deleteService));
  router.post('/services/upload', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.uploadServiceImage));
  router.post('/services/delete', apiWriteLimiter(), requireApiKey, asyncRoute(controllers.deleteServiceImage));

  // Services (Palvelukartta) — read endpoints
  router.get('/services', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getPublicServices));
  router.get('/services/all', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getAllServices));
  router.get('/services/slug/:slug', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getSingleServiceBySlug));
  router.get('/services/:id', apiReadLimiter(), requireApiKey, asyncRoute(controllers.getSingleService));

  router.use(errorHandler);
  parentRouter.use('/api/havaintokartta', router);
}

module.exports = {
  mount,
};
