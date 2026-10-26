import assert from 'node:assert/strict';
import test from 'node:test';

// The middleware module imports the pool but does not open a connection until
// a request reaches requireAuth; these tests stay completely database-free.
process.env.NODE_ENV ||= 'test';
process.env.APP_ORIGIN ||= 'http://localhost:3000';
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_PORT ||= '3306';
process.env.DB_USER ||= 'security-test';
process.env.DB_PASSWORD ||= 'security-test-only';
process.env.DB_NAME ||= 'never_connected_security_test';
process.env.JWT_ACCESS_SECRET ||= 'security-unit-access-secret-with-32-bytes';
process.env.JWT_REFRESH_SECRET ||= 'security-unit-refresh-secret-with-32-bytes';

const {
  ROLE_PERMISSIONS,
  hasPermission,
  permissionsForRole,
  rankOf,
  requirePermission,
  csrfProtection,
  signAccessToken,
  verifyAccessToken
} = await import('../../server/src/middleware/auth.js');

function runMiddleware(middleware, req) {
  return new Promise((resolve) => middleware(req, {}, (error) => resolve(error || null)));
}

test('staff permissions are explicit and separated by duty', () => {
  assert.deepEqual(ROLE_PERMISSIONS.user, []);
  assert.equal(hasPermission('support_agent', 'reports:read'), true);
  assert.equal(hasPermission('support_agent', 'reports:manage'), false);
  assert.equal(hasPermission('support_agent', 'users:read_sensitive'), false);

  assert.equal(hasPermission('analyst', 'analytics:read'), true);
  assert.equal(hasPermission('analyst', 'reports:read'), false);
  assert.equal(hasPermission('analyst', 'users:ban'), false);

  assert.equal(hasPermission('moderator', 'reports:manage'), true);
  assert.equal(hasPermission('moderator', 'verification:review'), true);
  assert.equal(hasPermission('moderator', 'roles:manage'), false);
  assert.equal(hasPermission('moderator', 'audit:read'), false);

  assert.equal(hasPermission('auditor', 'audit:read'), true);
  assert.equal(hasPermission('auditor', 'activity:read'), true);
  assert.equal(hasPermission('auditor', 'reports:manage'), false);
  assert.equal(hasPermission('auditor', 'audit:read_sensitive'), false);

  assert.equal(hasPermission('admin', 'users:read_sensitive'), true);
  assert.equal(hasPermission('admin', 'audit:read_sensitive'), true);
  assert.equal(hasPermission('admin', 'roles:manage'), true);
  assert.equal(hasPermission('admin', '*'), false);
  assert.deepEqual(permissionsForRole('super_admin'), ['*']);
  assert.equal(hasPermission('super_admin', 'any:future_permission'), true);
});

test('rank policy keeps sibling staff roles equal and super-admin above admin', () => {
  assert.equal(rankOf('support_agent'), rankOf('analyst'));
  assert.equal(rankOf('moderator'), rankOf('auditor'));
  assert.ok(rankOf('moderator') < rankOf('admin'));
  assert.ok(rankOf('admin') < rankOf('super_admin'));
  assert.equal(rankOf('unknown-role'), 0);
});

test('permission middleware returns a non-enumerating 404 for an authenticated role without access', async () => {
  const denied = await runMiddleware(requirePermission('users:ban'), { user: { role: 'moderator' } });
  assert.equal(denied?.status, 404);
  assert.equal(denied?.code, 'NOT_FOUND');

  const anonymous = await runMiddleware(requirePermission('admin:access'), {});
  assert.equal(anonymous?.status, 401);
  assert.equal(anonymous?.code, 'NO_TOKEN');

  const allowed = await runMiddleware(requirePermission('analytics:read'), { user: { role: 'analyst' } });
  assert.equal(allowed, null);
});

test('CSRF middleware allows safe requests and rejects missing or mismatched tokens', async () => {
  assert.equal(await runMiddleware(csrfProtection, { method: 'GET' }), null);
  assert.equal(await runMiddleware(csrfProtection, { method: 'OPTIONS' }), null);

  const missing = await runMiddleware(csrfProtection, {
    method: 'POST', cookies: {}, body: {}, get: () => undefined
  });
  assert.equal(missing?.status, 403);
  assert.equal(missing?.code, 'CSRF_MISSING');

  const mismatch = await runMiddleware(csrfProtection, {
    method: 'POST', cookies: { ec_csrf: 'cookie-token' }, body: {},
    get: () => 'different-token'
  });
  assert.equal(mismatch?.status, 403);
  assert.equal(mismatch?.code, 'CSRF_INVALID');

  const matched = await runMiddleware(csrfProtection, {
    method: 'POST', cookies: { ec_csrf: 'same-token' }, body: {},
    get: () => 'same-token'
  });
  assert.equal(matched, null);
});

test('access JWTs do not carry staff roles; authorization must use current database role', () => {
  const payload = verifyAccessToken(signAccessToken({ id: 17, email: 'private@example.test', display_name: 'Test' }));
  assert.equal(payload.sub, '17');
  assert.equal(Object.hasOwn(payload, 'role'), false);
  assert.equal(Object.hasOwn(payload, 'permissions'), false);
});
