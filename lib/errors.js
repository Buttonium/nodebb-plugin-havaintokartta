'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function create(status, message) {
  return new HttpError(status, message);
}

module.exports = {
  HttpError,
  badRequest(message) {
    return create(400, message);
  },
  unauthorized(message) {
    return create(401, message);
  },
  forbidden(message) {
    return create(403, message);
  },
  notFound(message) {
    return create(404, message);
  },
  conflict(message) {
    return create(409, message);
  },
  serviceUnavailable(message) {
    return create(503, message);
  },
};
