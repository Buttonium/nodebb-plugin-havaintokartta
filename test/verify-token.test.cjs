'use strict';



const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

process.env.NODEBB_API_KEY = 'test-api-key-0123456789abcdef';

// Distinct groups per role so each role's membership is independently
// controllable (config is read from env on first getConfig() call).
process.env.NODEBB_OPERATOR_GROUPS = 'op-group';
process.env.PALVELUKARTTA_OPERATOR_GROUPS = 'pvk-group';
process.env.NODEBB_UUTISET_WRITER_GROUPS = 'writer-group';
process.env.NODEBB_EVENT_MAINTAINER_GROUPS = 'events-group';
process.env.NODEBB_ADMIN_GROUPS = 'admin-group';

// Stub nconf (lib/config.js reads it through require.main.require).
const originalLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === 'nconf') {
    return {
      get: (key) => {
        if (key === 'url') return 'https://forum.example';
        return undefined;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Stub NodeBB internals (require.main.require calls inside lib/nodebb.js).
const revokedKeys = new Set();
const userRecords = new Map(); // uid(string) -> { uid, banned }
const membership = new Map(); // uid(string) -> Set(groupName)

const db = {
  exists: async (key) => revokedKeys.has(key),
  set: async () => {},
  expire: async () => {},
};

const groups = {
  isMember: async (uid, groupName) =>
    membership.get(String(uid))?.has(groupName) ?? false,
};

const user = {
  getUserFields: async (uid) => userRecords.get(String(uid)) ?? null,
};

const originalMainRequire = require.main.require;
require.main.require = function stubbedMainRequire(id) {
  if (id === './src/database') return db;
  if (id === './src/groups') return groups;
  if (id === './src/topics') return {};
  if (id === './src/user') return user;
  return originalMainRequire.call(this, id);
};

const sso = require('../lib/sso.js');

const REVOKE_KEY = (sig) =>
  `havaintokartta:revoke:${crypto.createHash('sha256').update(sig).digest('hex')}`;

function setMemberships(uid, groupNames) {
  membership.set(String(uid), new Set(groupNames));
}

function makeUser(uid, banned = 0) {
  userRecords.set(String(uid), { uid, banned });
}

function expectBadRequest(promise, messagePattern) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.status, 400, `expected status 400, got ${err.status}`);
    if (messagePattern) {
      assert.match(err.message, messagePattern, `unexpected message: ${err.message}`);
    }
    return true;
  });
}

test.before(() => {
  // ensure clean state regardless of test order
  userRecords.clear();
  membership.clear();
  revokedKeys.clear();
});

test('malformed input never yields { revoked: false }', async () => {
  // Missing / empty tokenSignature.
  await expectBadRequest(
    sso.verifyTokenClaims(undefined, '1', ['user']),
    /tokenSignature is required/
  );
  await expectBadRequest(
    sso.verifyTokenClaims('  ', '1', ['user']),
    /tokenSignature is required/
  );

  // Invalid uid: missing, non-numeric, zero, negative, non-integer.
  await expectBadRequest(sso.verifyTokenClaims('sig1', undefined, ['user']), /uid must be a positive integer/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', 'abc', ['user']), /uid must be a positive integer/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', '0', ['user']), /uid must be a positive integer/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', '-5', ['user']), /uid must be a positive integer/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', '', ['user']), /uid must be a positive integer/);

  // Invalid roles: missing, non-array, empty string entry, non-string entry.
  await expectBadRequest(sso.verifyTokenClaims('sig1', '1', undefined), /roles must be an array/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', '1', 'user'), /roles must be an array/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', '1', ['user', '']), /roles must be an array/);
  await expectBadRequest(sso.verifyTokenClaims('sig1', '1', ['user', 42]), /roles must be an array/);
});

test('deny-listed signature is revoked before any account lookup', async () => {
  let accountLookups = 0;
  const originalGetUserFields = user.getUserFields;
  user.getUserFields = async (uid) => {
    accountLookups += 1;
    return originalGetUserFields(uid);
  };

  makeUser(1);
  setMemberships(1, ['op-group']);
  revokedKeys.add(REVOKE_KEY('revoked-sig'));

  const result = await sso.verifyTokenClaims('revoked-sig', '1', ['user', 'operator']);
  assert.deepEqual(result, { revoked: true });
  assert.equal(accountLookups, 0, 'deny list must short-circuit before the account check');

  user.getUserFields = originalGetUserFields;
});

test('deleted account is revoked even if all roles are still embedded', async () => {
  // No record for uid 99 in userRecords.
  const result = await sso.verifyTokenClaims('sig-del', '99', ['user', 'operator']);
  assert.deepEqual(result, { revoked: true });
});

test('banned account is revoked', async () => {
  makeUser(2, Date.now() + 1000);
  setMemberships(2, ['op-group']);

  const result = await sso.verifyTokenClaims('sig-ban', '2', ['user', 'operator']);
  assert.deepEqual(result, { revoked: true });
});

test('unbanned existing account with no privileged roles is not revoked', async () => {
  makeUser(3);
  setMemberships(3, []);

  const result = await sso.verifyTokenClaims('sig-plain', '3', ['user']);
  assert.deepEqual(result, { revoked: false });
});

// Every privileged role individually: a token embedding the role is valid
// while the user holds the backing group, and revoked after removal.
const ROLE_GROUPS = [
  ['operator', 'op-group'],
  ['palvelukartta-operator', 'pvk-group'],
  ['writer', 'writer-group'],
  ['event-maintainer', 'events-group'],
  ['admin', 'admin-group'],
];

test('each privileged role is accepted while the backing group is held', async () => {
  for (const [role, group] of ROLE_GROUPS) {
    const uid = ROLE_GROUPS.findIndex(([, g]) => g === group) + 10;
    makeUser(uid);
    setMemberships(uid, [group]);

    const result = await sso.verifyTokenClaims(`sig-${role}`, String(uid), ['user', role]);
    assert.deepEqual(result, { revoked: false }, `role ${role} should be accepted`);
  }
});

test('each privileged role is revoked after the backing group is removed', async () => {
  for (const [role, group] of ROLE_GROUPS) {
    const uid = ROLE_GROUPS.findIndex(([, g]) => g === group) + 10;
    makeUser(uid);
    setMemberships(uid, []); // removed from every group

    const result = await sso.verifyTokenClaims(`sig-${role}-removed`, String(uid), ['user', role]);
    assert.deepEqual(result, { revoked: true }, `role ${role} should be revoked`);
  }
});

test('partial role removal of one of several embedded roles revokes', async () => {
  const uid = 50;
  makeUser(uid);
  // Writer was removed, admin is still held.
  setMemberships(uid, ['admin-group']);

  const result = await sso.verifyTokenClaims('sig-partial', String(uid), ['user', 'writer', 'admin']);
  assert.deepEqual(result, { revoked: true });
});

test('partial role removal keeps the token valid when all embedded roles remain', async () => {
  const uid = 51;
  makeUser(uid);
  setMemberships(uid, ['writer-group', 'admin-group']);

  const result = await sso.verifyTokenClaims('sig-partial-ok', String(uid), ['user', 'writer', 'admin']);
  assert.deepEqual(result, { revoked: false });
});

test('newly gained roles do not invalidate the token', async () => {
  const uid = 60;
  makeUser(uid);
  setMemberships(uid, ['op-group']); // promoted since the token was issued

  const result = await sso.verifyTokenClaims('sig-gained', String(uid), ['user']);
  assert.deepEqual(result, { revoked: false });
});

for (const uid of ['1abc', '1.5', 1.5, [1], {}, true, ' 1 ', '1e2', '0x10', Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
  test(`rejects malformed uid ${JSON.stringify(uid)} without checking another account`, async () => {
    makeUser(1);
    await expectBadRequest(sso.verifyTokenClaims('sig-malformed', uid, ['user']), /uid must be a positive integer/);
  });
}

test('accepts numeric and string positive integer UIDs', async () => {
  makeUser(71);
  for (const uid of [71, '71']) {
    assert.deepEqual(await sso.verifyTokenClaims('sig-valid-uid', uid, ['user']), { revoked: false });
  }
});
