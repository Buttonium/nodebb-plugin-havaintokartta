'use strict';

// Regression tests for lib/rate-limit.js: unauthenticated requests are keyed
// by client IP (IPv6 grouped into /56 subnets) and authenticated requests by
// the API key. Drives the real middleware with fake req/res objects.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stub nconf (a NodeBB peer dep) so lib/config.js loads standalone.
const originalLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === 'nconf') {
    return { get: () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// getConfig().apiKey is read from the environment on first call (then cached).
process.env.NODEBB_API_KEY = 'test-api-key-0123456789abcdef';

const { publicLimiter } = require('../lib/rate-limit.js');

// Keep in sync with CONFIG.public.max in lib/rate-limit.js.
const PUBLIC_MAX = 120;

function makeRes() {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {},
    on() {},
  };
}

async function sendRequest(limiter, { ip = '203.0.113.7', authorization = null } = {}) {
  const headers = {};
  if (authorization) {
    headers.authorization = authorization;
  }
  // Fresh req object per call, like real HTTP requests.
  const req = { ip, headers, method: 'GET', path: '/' };
  const res = makeRes();
  let nextError;
  await limiter(req, res, (err) => {
    nextError = err;
  });
  return {
    limited: res.statusCode === 429,
    nextError,
  };
}

test('regression: unauthenticated requests are rate-limited per IP', async () => {
  const limiter = publicLimiter();

  for (let i = 0; i < PUBLIC_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendRequest(limiter);
    assert.equal(result.limited, false, `request ${i + 1} of ${PUBLIC_MAX} should pass`);
    assert.equal(result.nextError, undefined, 'middleware must not error');
  }

  const over = await sendRequest(limiter);
  assert.equal(over.limited, true, 'request over the limit must be rejected with 429');
});

test('requests with an INVALID API key fall back to per-IP limiting', async () => {
  const limiter = publicLimiter();

  for (let i = 0; i < PUBLIC_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendRequest(limiter, { authorization: 'Bearer wrong-key' });
    assert.equal(result.limited, false, `request ${i + 1} of ${PUBLIC_MAX} should pass`);
  }

  const over = await sendRequest(limiter, { authorization: 'Bearer wrong-key' });
  assert.equal(over.limited, true, 'invalid-key flood must still be limited by IP');
});

test('a different client IP gets its own bucket', async () => {
  const limiter = publicLimiter();

  for (let i = 0; i < PUBLIC_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sendRequest(limiter, { ip: '198.51.100.10' });
  }

  const otherIp = await sendRequest(limiter, { ip: '198.51.100.11' });
  assert.equal(otherIp.limited, false, 'another IP must not be affected by a full bucket');
});

test('requests with the VALID API key are keyed by the key, not the IP', async () => {
  const limiter = publicLimiter();

  for (let i = 0; i < PUBLIC_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sendRequest(limiter, { ip: '203.0.113.99' });
  }

  const authed = await sendRequest(limiter, {
    ip: '203.0.113.99',
    authorization: `Bearer ${process.env.NODEBB_API_KEY}`,
  });
  assert.equal(authed.limited, false, 'valid API key must not share the IP bucket');
});

test('IPv6 clients in the same /56 subnet share one bucket (why ipKeyGenerator is used)', async () => {
  const limiter = publicLimiter();
  // Addresses differ only in the last hextet → same /56 subnet.
  const makeIp = (n) => `2001:db8:aaaa:bbbb:0000:0000:0000:${n.toString(16)}`;

  for (let i = 0; i < PUBLIC_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendRequest(limiter, { ip: makeIp(i % 2) });
    assert.equal(result.limited, false, `request ${i + 1} of ${PUBLIC_MAX} should pass`);
  }

  const over = await sendRequest(limiter, { ip: makeIp(2) });
  assert.equal(over.limited, true, 'same-subnet IPv6 clients must share the bucket');
});
