#!/usr/bin/env node
/**
 * Disposable-MySQL security integration checks. Creates temporary synthetic
 * accounts/content, decrypts only test outbox rows in-process, then removes them.
 * This mutating suite refuses to run outside the explicitly enabled local CI DB.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../server/src/config/env.js';
import { execute, queryOne, pool } from '../server/src/db/pool.js';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const targetUrl = new URL(BASE);
const allowed = process.env.ALLOW_SYNTHETIC_SECURITY_TESTS === '1' &&
  process.env.CI === 'true' && process.env.NODE_ENV !== 'production' &&
  ['127.0.0.1', 'localhost'].includes(targetUrl.hostname) &&
  ['127.0.0.1', 'localhost'].includes(String(env.DB.host).toLowerCase()) &&
  process.env.DB_NAME === 'ember_ci';

if (!allowed) {
  console.error('[security-integration] refused: this mutating suite runs only when explicitly enabled against local disposable CI database ember_ci.');
  process.exitCode = 2;
} else {
  await run();
}

async function run() {
  const tag = crypto.randomBytes(4).toString('hex');
  const initialPassword = 'SecurityTestOnly42!';
  const resetPassword = 'SecurityTestOnly84!';
  const users = [];
  let reportId = null;
  let postId = null;
  let evidenceKey = null;
  const deletionKeys = [];
  const deletionFiles = [];
  let selfVerificationId = null;
  const outboxBefore = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS id FROM delivery_outbox'))?.id || 0);
  const auditBefore = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS id FROM admin_audit_log'))?.id || 0);
  const activityBefore = Number((await queryOne('SELECT COALESCE(MAX(id), 0) AS id FROM activity_events'))?.id || 0);
  let failure = null;

  const pass = (message) => console.log(`  ok  ${message}`);
  const checkStatus = (response, expected, label) => {
    assert.equal(response.status, expected, `${label} (expected ${expected}, received ${response.status})`);
    pass(label);
  };

  try {
    const register = async (label) => {
      const email = `security-${tag}-${label}@example.test`;
      const username = `ci_sec_${label}_${tag}`;
      const response = await call('/api/auth/register', {
        method: 'POST',
        body: { email, username, password: initialPassword, displayName: 'Security Test', gender: 'other' }
      });
      checkStatus(response, 201, `create isolated synthetic ${label} account`);
      const item = {
        label, email, username, id: Number(response.json.user.id), session: sessionFrom(response)
      };
      users.push(item);
      return item;
    };

    const regular = await register('regular');
    const support = await register('support');
    const analyst = await register('analyst');
    const moderator = await register('moderator');
    const auditor = await register('auditor');
    const administrator = await register('admin');
    const target = await register('target');
    const deletionTarget = await register('delete');

    for (const [user, role] of [
      [support, 'support_agent'], [analyst, 'analyst'], [moderator, 'moderator'],
      [auditor, 'auditor'], [administrator, 'admin']
    ]) {
      await execute('UPDATE users SET role = ? WHERE id = ?', [role, user.id]);
    }

    const whoami = await call('/api/admin/whoami', { session: administrator.session });
    checkStatus(whoami, 200, 'admin permission context is served by the authenticated API');
    assert.ok(whoami.json.permissions.includes('users:read_sensitive'));
    assert.ok(!whoami.json.permissions.includes('*'));
    pass('admin permission response is explicit rather than a client-side role guess');

    checkStatus(await call('/api/admin/whoami', { session: regular.session }), 404,
      'non-staff admin discovery returns the non-enumerating 404');
    checkStatus(await call('/api/admin/reports', { session: analyst.session }), 404,
      'analysts cannot read moderation reports');
    checkStatus(await call('/api/admin/health', { session: auditor.session }), 404,
      'auditors cannot access system health');
    checkStatus(await call(`/api/admin/users/${target.id}/ban`, {
      method: 'POST', session: moderator.session, body: { reason: 'should not be authorized' }
    }), 404, 'moderators cannot call the admin-only ban route');
    checkStatus(await call('/api/admin/overview', { session: analyst.session }), 200,
      'analysts can read real database-backed analytics');
    checkStatus(await call('/api/admin/health', { session: administrator.session }), 200,
      'admin can access live health checks');
    const settings = await call('/api/admin/settings', { session: administrator.session });
    checkStatus(settings, 200, 'admin can read secret-free runtime settings');
    assert.equal(Object.hasOwn(settings.json, 'secrets'), false);
    assert.equal(Object.hasOwn(settings.json.operations, 'databaseHost'), false);

    const supportSearch = await call(`/api/admin/users?${new URLSearchParams({ q: target.email })}`, {
      session: support.session
    });
    checkStatus(supportSearch, 200, 'support user search is available');
    assert.equal(supportSearch.json.canViewSensitive, false);
    assert.equal(supportSearch.json.users.length, 0, 'support search must not match an email address');
    const supportDetail = await call(`/api/admin/users/${target.id}`, { session: support.session });
    checkStatus(supportDetail, 200, 'support can read a role-limited account detail');
    assert.equal(Object.hasOwn(supportDetail.json.user, 'email'), false);
    assert.equal(Object.hasOwn(supportDetail.json.user, 'phone'), false);
    pass('support responses omit email and phone PII');

    const adminSearch = await call(`/api/admin/users?${new URLSearchParams({ q: target.email })}`, {
      session: administrator.session
    });
    checkStatus(adminSearch, 200, 'admin can perform an explicitly authorized email lookup');
    assert.equal(adminSearch.json.users.length, 1);
    assert.equal(adminSearch.json.users[0].email, target.email);
    pass('authorized sensitive lookup returns the synthetic email only to admin');

    checkStatus(await call(`/api/admin/users/${target.id}/suspend`, {
      method: 'POST', session: administrator.session, csrf: false, body: { days: 1 }
    }), 403, 'moderation writes reject a missing CSRF token');
    const suspended = await call(`/api/admin/users/${target.id}/suspend`, {
      method: 'POST', session: administrator.session,
      body: { days: 1, reason: 'synthetic security integration test' }
    });
    checkStatus(suspended, 200, 'admin can suspend a lower-ranked synthetic account');
    assert.equal(suspended.json.user.status, 'suspended');
    const restored = await call(`/api/admin/users/${target.id}/restore`, {
      method: 'POST', session: administrator.session, body: {}
    });
    checkStatus(restored, 200, 'admin can restore the synthetic suspended account');

    const selfRoleChange = await call(`/api/admin/users/${administrator.id}/role`, {
      method: 'POST', session: administrator.session, body: { role: 'super_admin' }
    });
    assert.ok([400, 403].includes(selfRoleChange.status), 'self-promotion must be rejected');
    pass('role changes cannot self-promote');

    const auditQuery = new URLSearchParams({ action: 'user.suspend', limit: '50' });
    const auditorLog = await call(`/api/admin/audit?${auditQuery}`, { session: auditor.session });
    checkStatus(auditorLog, 200, 'auditor can read the privacy-filtered audit trail');
    const auditorSuspend = auditorLog.json.entries.find((entry) => entry.targetId === target.id);
    assert.ok(auditorSuspend, 'the transactional suspension audit entry exists');
    assert.equal(auditorSuspend.ip, null, 'auditor must not receive sensitive client IP data');
    const adminLog = await call(`/api/admin/audit?${auditQuery}`, { session: administrator.session });
    checkStatus(adminLog, 200, 'admin can read sensitive audit details');
    const adminSuspend = adminLog.json.entries.find((entry) => entry.targetId === target.id);
    assert.ok(adminSuspend?.ip, 'admin audit entry includes the captured request IP');
    const activity = await call(`/api/admin/activity?${new URLSearchParams({ eventType: 'user.suspend', limit: '50' })}`, {
      session: auditor.session
    });
    checkStatus(activity, 200, 'auditor can read the privacy-filtered activity stream');
    assert.ok(activity.json.entries.some((entry) => entry.subjectUserId === target.id));
    pass('audit and activity records commit with moderation without exposing IP to auditors');

    const messageCanary = `PRIVATE_MESSAGE_CANARY_${tag}`;
    const reportInsert = await execute(
      `INSERT INTO content_reports
         (reporter_id, target_type, target_id, reported_user_id, reason, details, status, snapshot, resolution)
       VALUES (?, 'message', ?, ?, 'harassment', ?, 'open', ?, ?)`,
      [regular.id, Date.now(), target.id, messageCanary, JSON.stringify({ body: messageCanary }), messageCanary]
    );
    reportId = Number(reportInsert.insertId);
    const reportDetail = await call(`/api/admin/reports/${reportId}`, { session: moderator.session });
    checkStatus(reportDetail, 200, 'moderator can review a report record');
    assert.equal(JSON.stringify(reportDetail.json).includes(messageCanary), false);
    assert.equal(reportDetail.json.details, null);
    const reviewedReport = await call(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST', session: moderator.session, body: { status: 'reviewing', resolution: messageCanary }
    });
    checkStatus(reviewedReport, 200, 'moderator can move the synthetic report into review');
    assert.equal(JSON.stringify(reviewedReport.json).includes(messageCanary), false);
    const storedResolution = await queryOne('SELECT resolution FROM content_reports WHERE id = ?', [reportId]);
    assert.equal(storedResolution.resolution, null);
    pass('private message report text is neither returned nor persisted in a resolution');

    const postInsert = await execute(
      'INSERT INTO posts (user_id, body, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))',
      [target.id, 'synthetic removable test post']
    );
    postId = Number(postInsert.insertId);
    const removed = await call('/api/admin/content/remove', {
      method: 'POST', session: moderator.session, body: { targetType: 'post', targetId: postId }
    });
    checkStatus(removed, 200, 'moderator can soft-remove synthetic content');
    const postState = await queryOne('SELECT deleted_at, deleted_by FROM posts WHERE id = ?', [postId]);
    assert.ok(postState.deleted_at);
    assert.equal(Number(postState.deleted_by), moderator.id);
    pass('content moderation retains the row and records the moderator');

    evidenceKey = `verification/${crypto.randomUUID()}.jpg`;
    const evidencePath = path.join(env.UPLOAD_DIR, ...evidenceKey.split('/'));
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 80, g: 130, b: 170 } }
    }).jpeg().toBuffer();
    await fs.writeFile(evidencePath, image);
    const verificationInsert = await execute(
      "INSERT INTO verifications (user_id, gesture, file_path, status) VALUES (?, 'peace', ?, 'pending')",
      [regular.id, evidenceKey]
    );
    const verificationId = Number(verificationInsert.insertId);
    checkStatus(await call(`/api/admin/verifications/${verificationId}/evidence`, {
      session: support.session
    }), 404, 'staff without verification-review permission cannot retrieve private evidence');
    const evidence = await call(`/api/admin/verifications/${verificationId}/evidence`, {
      session: moderator.session
    });
    checkStatus(evidence, 200, 'authorized reviewer can retrieve pending evidence');
    assert.match(evidence.headers.get('cache-control') || '', /private, no-store/i);
    assert.equal(evidence.headers.get('content-type'), 'image/jpeg');
    assert.equal(evidence.bytes.length, image.length);
    const selfRequest = await execute(
      "INSERT INTO verifications (user_id, gesture, file_path, status) VALUES (?, 'wave', NULL, 'pending')",
      [moderator.id]
    );
    selfVerificationId = Number(selfRequest.insertId);
    checkStatus(await call(`/api/admin/verifications/${selfVerificationId}/review`, {
      method: 'POST', session: moderator.session, body: { decision: 'approved' }
    }), 403, 'staff cannot approve their own photo verification');
    checkStatus(await call(`/api/admin/verifications/${verificationId}/review`, {
      method: 'POST', session: moderator.session, body: { decision: 'approved', note: 'Synthetic CI approval.' }
    }), 200, 'reviewer can approve a different synthetic account');
    const verificationState = await queryOne(
      'SELECT status, file_path FROM verifications WHERE id = ?', [verificationId]
    );
    const verifiedUser = await queryOne('SELECT is_verified FROM users WHERE id = ?', [regular.id]);
    assert.equal(verificationState.status, 'approved');
    assert.equal(verificationState.file_path, null);
    assert.equal(Number(verifiedUser.is_verified), 1);
    const queueRow = await queryOne(
      "SELECT id FROM media_deletion_queue WHERE file_key = ? AND reason = 'verification_reviewed' LIMIT 1",
      [evidenceKey]
    );
    const fileExists = await fs.access(evidencePath).then(() => true, () => false);
    assert.ok(queueRow || !fileExists, 'reviewed evidence is queued for deletion or has already been unlinked');
    pass('reviewed evidence stays private, its DB path is cleared, and deletion is durable');

    const emailStart = await call('/api/users/me/verify/start', {
      method: 'POST', session: regular.session, body: { kind: 'email' }
    });
    checkStatus(emailStart, 200, 'email verification code can be issued through the authenticated flow');
    assert.equal(Object.hasOwn(emailStart.json, 'code'), false);
    assert.equal(Object.hasOwn(emailStart.json, 'devCode'), false);
    const emailPayload = await outboxPayload('email_verification', outboxBefore);
    assert.match(emailPayload.code || '', /^\d{6}$/);
    const tokenRow = await queryOne(
      "SELECT token_hash FROM verification_tokens WHERE user_id = ? AND kind = 'email' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id DESC LIMIT 1",
      [regular.id]
    );
    const plainDigest = crypto.createHash('sha256').update(emailPayload.code).digest('hex');
    assert.notEqual(tokenRow.token_hash, plainDigest);
    const confirmations = await Promise.all([
      call('/api/users/me/verify/confirm', {
        method: 'POST', session: regular.session, body: { kind: 'email', code: emailPayload.code }
      }),
      call('/api/users/me/verify/confirm', {
        method: 'POST', session: regular.session, body: { kind: 'email', code: emailPayload.code }
      })
    ]);
    assert.deepEqual(confirmations.map((response) => response.status).sort(), [200, 400]);
    pass('verification code is keyed at rest, never returned, and consumed exactly once');

    for (let send = 0; send < 4; send += 1) {
      const resend = await call('/api/users/me/verify/start', {
        method: 'POST', session: regular.session, body: { kind: 'email' }
      });
      checkStatus(resend, 200, `verification resend ${send + 2} remains inside the rolling send allowance`);
      assert.equal(Object.hasOwn(resend.json, 'code'), false);
    }
    const issuanceHistory = await queryOne(
      `SELECT COUNT(*) AS n FROM verification_tokens
        WHERE user_id = ? AND kind = 'email' AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
      [regular.id]
    );
    assert.equal(Number(issuanceHistory.n), 5, 'used and revoked issuances remain in the rolling count');
    const cappedSend = await call('/api/users/me/verify/start', {
      method: 'POST', session: regular.session, body: { kind: 'email' }
    });
    checkStatus(cappedSend, 429, 'a sixth resend is blocked instead of erasing its send history');
    pass('resend invalidation preserves issuance history for the per-kind rolling send cap');

    const phone = `+23470${String(crypto.randomInt(0, 100_000_000)).padStart(8, '0')}`;
    const phoneStart = await call('/api/users/me/verify/start', {
      method: 'POST', session: regular.session, body: { kind: 'phone', phone }
    });
    checkStatus(phoneStart, 200, 'phone verification can be queued without embedding provider credentials');
    assert.equal(Object.hasOwn(phoneStart.json, 'code'), false);
    const phonePayload = await outboxPayload('sms_verification', outboxBefore);
    assert.equal(phonePayload.to, phone);
    checkStatus(await call('/api/users/me/verify/confirm', {
      method: 'POST', session: regular.session, body: { kind: 'phone', code: phonePayload.code }
    }), 200, 'phone verification code can be confirmed');
    checkStatus(await call('/api/users/me/verify/start', {
      method: 'POST', session: target.session, body: { kind: 'phone', phone }
    }), 409, 'a phone number already claimed by another account cannot be verified twice');

    checkStatus(await call('/api/auth/me', { session: regular.session }), 200,
      'the account has a live session before password recovery');
    const knownReset = await call('/api/auth/forgot-password', {
      method: 'POST', body: { email: regular.email }
    });
    const unknownReset = await call('/api/auth/forgot-password', {
      method: 'POST', body: { email: `unknown-${tag}@example.test` }
    });
    checkStatus(knownReset, 200, 'known-account recovery returns the generic response');
    checkStatus(unknownReset, 200, 'unknown-account recovery returns the generic response');
    assert.deepEqual(knownReset.json, unknownReset.json);
    const resetPayload = await outboxPayload('password_reset', outboxBefore);
    assert.equal(resetPayload.to, regular.email);
    assert.ok(resetPayload.token);
    assert.equal(JSON.stringify(knownReset.json).includes(resetPayload.token), false);
    const resetHash = await queryOne(
      'SELECT token_hash FROM password_resets WHERE user_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1',
      [regular.id]
    );
    assert.equal(resetHash.token_hash, crypto.createHash('sha256').update(resetPayload.token).digest('hex'));
    assert.notEqual(resetHash.token_hash, resetPayload.token);
    const resetAttempts = await Promise.all([
      call('/api/auth/reset-password', {
        method: 'POST', body: { token: resetPayload.token, password: resetPassword }
      }),
      call('/api/auth/reset-password', {
        method: 'POST', body: { token: resetPayload.token, password: resetPassword }
      })
    ]);
    assert.deepEqual(resetAttempts.map((response) => response.status).sort(), [200, 400]);
    pass('concurrent password-reset submissions consume the bearer token exactly once');
    checkStatus(await call('/api/auth/me', { session: regular.session }), 401,
      'password reset invalidates the previous access session immediately');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const newLogin = await call('/api/auth/login', {
      method: 'POST', body: { email: regular.email, password: resetPassword }
    });
    checkStatus(newLogin, 200, 'the new credential works after session invalidation');
    checkStatus(await call('/api/auth/me', { session: sessionFrom(newLogin) }), 200,
      'newly issued post-reset session is accepted');
    pass('password recovery is non-enumerating, one-use, and ends old access and refresh sessions');

    const photoId = crypto.randomUUID();
    const photoKey = `photos/${photoId}.jpg`;
    const thumbKey = `thumbs/${photoId}.webp`;
    deletionKeys.push(photoKey, thumbKey);
    const photoPath = path.join(env.UPLOAD_DIR, ...photoKey.split('/'));
    const thumbPath = path.join(env.UPLOAD_DIR, ...thumbKey.split('/'));
    deletionFiles.push(photoPath, thumbPath);
    await fs.mkdir(path.dirname(photoPath), { recursive: true });
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await fs.writeFile(photoPath, image);
    await fs.writeFile(thumbPath, image);
    await execute(
      'INSERT INTO user_photos (user_id, url, thumb_url, position) VALUES (?, ?, ?, 0)',
      [deletionTarget.id, `/api/photos/${photoId}.jpg`, `/api/photos/${photoId}.webp`]
    );
    const deleteResponse = await call('/api/users/me', {
      method: 'DELETE', session: deletionTarget.session
    });
    checkStatus(deleteResponse, 200, 'account deletion accepts the authenticated user request');
    assert.equal(deleteResponse.json.mediaCleanupQueued, 2);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM users WHERE id = ?', [deletionTarget.id])).n), 0);
    const queuedDeletion = await queryOne(
      `SELECT COUNT(*) AS n FROM media_deletion_queue
        WHERE reason = 'account_deleted' AND file_key IN (?, ?)`, deletionKeys
    );
    assert.equal(Number(queuedDeletion.n), 2);
    checkStatus(await call('/api/auth/me', { session: deletionTarget.session }), 401,
      'account deletion revokes the deleted account session');
    pass('account deletion queues profile photos and thumbnails instead of cascading them away or deleting them synchronously');

    console.log('\nsecurity integration: all synthetic checks passed');
  } catch (error) {
    failure = error;
    console.error(`[security-integration] ${error.message}`);
  } finally {
    try {
      if (reportId) await execute('DELETE FROM content_reports WHERE id = ?', [reportId]).catch(() => {});
      if (postId) await execute('DELETE FROM posts WHERE id = ?', [postId]).catch(() => {});
      if (selfVerificationId) await execute('DELETE FROM verifications WHERE id = ?', [selfVerificationId]).catch(() => {});
      if (evidenceKey) {
        await execute('DELETE FROM media_deletion_queue WHERE file_key = ?', [evidenceKey]).catch(() => {});
        await fs.rm(path.join(env.UPLOAD_DIR, ...evidenceKey.split('/')), { force: true }).catch(() => {});
      }
      if (deletionKeys.length) {
        await execute(
          `DELETE FROM media_deletion_queue WHERE file_key IN (${deletionKeys.map(() => '?').join(',')})`,
          deletionKeys
        ).catch(() => {});
      }
      await Promise.all(deletionFiles.map((file) => fs.rm(file, { force: true }).catch(() => {})));
      await execute('DELETE FROM admin_audit_log WHERE id > ?', [auditBefore]).catch(() => {});
      await execute('DELETE FROM activity_events WHERE id > ?', [activityBefore]).catch(() => {});
      if (users.length) {
        const ids = users.map((user) => user.id);
        const placeholders = ids.map(() => '?').join(',');
        await execute(`DELETE FROM users WHERE id IN (${placeholders})`, ids);
      }
      await execute('DELETE FROM delivery_outbox WHERE id > ?', [outboxBefore]).catch(() => {});
    } catch (cleanupError) {
      failure ||= cleanupError;
      console.error(`[security-integration] synthetic-data cleanup failed: ${cleanupError.code || 'CLEANUP_ERROR'}`);
    }
    await pool.end().catch(() => {});
  }

  if (failure) process.exitCode = 1;
}

async function call(route, { method = 'GET', session = null, csrf = null, body = undefined } = {}) {
  const headers = { accept: 'application/json' };
  if (session?.cookie) headers.cookie = session.cookie;
  const csrfToken = csrf === false ? null : csrf || session?.csrfToken;
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: 'manual'
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  let json = null;
  if (contentType.includes('application/json') && bytes.length) {
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, bytes, json };
}

function sessionFrom(response) {
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const cookies = new Map();
  for (const line of lines) {
    const match = /(?:^|,\s*)(ec_at|ec_rt|ec_csrf)=([^;,]*)/.exec(line);
    if (match) cookies.set(match[1], `${match[1]}=${match[2]}`);
  }
  for (const name of ['ec_at', 'ec_rt', 'ec_csrf']) assert.ok(cookies.has(name), `registration/login must set ${name}`);
  assert.ok(response.json?.csrfToken, 'registration/login must return a CSRF token');
  return { cookie: [...cookies.values()].join('; '), csrfToken: response.json.csrfToken };
}

async function outboxPayload(kind, afterId) {
  const row = await queryOne(
    `SELECT payload_ciphertext, payload_iv, payload_tag
       FROM delivery_outbox
      WHERE id > ? AND kind = ? AND payload_ciphertext IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [afterId, kind]
  );
  assert.ok(row, `the ${kind} delivery is persisted in the encrypted outbox`);
  const key = crypto
    .createHmac('sha256', env.JWT.refreshSecret)
    .update('ember-delivery-outbox-v1')
    .digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.payload_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.payload_tag, 'base64'));
  const payload = Buffer.concat([
    decipher.update(Buffer.from(row.payload_ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(payload);
}
