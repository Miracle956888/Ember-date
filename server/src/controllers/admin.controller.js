import path from 'node:path';
import { asyncHandler, badRequest, notFound } from '../utils/errors.js';
import { hasPermission, permissionsForRole } from '../middleware/auth.js';
import { storage } from '../services/storage.service.js';
import * as adminService from '../services/admin.service.js';

/** Trust proxy headers only when Express has been explicitly configured to do so. */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function positiveId(raw, label = 'id') {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest(`Invalid ${label}.`);
  return value;
}

function optionalInteger(raw, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw badRequest(`Invalid ${label}.`);
  return value;
}

function pageLimit(raw, fallback = 25) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw badRequest('Limit must be between 1 and 100.');
  return value;
}

// ------------------------------------------------------------- access / system

export const whoami = asyncHandler(async (req, res) => {
  const permissions = permissionsForRole(req.user.role);
  res.json({
    id: req.user.id,
    role: req.user.role,
    permissions,
    canAudit: hasPermission(req.user.role, 'audit:read')
  });
});

export const overview = asyncHandler(async (req, res) => {
  res.json(await adminService.analytics(req.user.role));
});

export const health = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await adminService.health(req.user.role));
});

export const settings = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await adminService.settings(req.user.role));
});

// ---------------------------------------------------------- report queue

export const reports = asyncHandler(async (req, res) => {
  const { status, limit, targetType, reason, cursorPriority, cursorId } = req.query;
  const hasPriority = cursorPriority !== undefined;
  const hasId = cursorId !== undefined;
  if (hasPriority !== hasId) throw badRequest('Both report cursor values are required.');
  let cursor = null;
  if (hasPriority && hasId) {
    const priority = optionalInteger(cursorPriority, 'cursor priority', { min: 0, max: 255 });
    const id = optionalInteger(cursorId, 'cursor id');
    cursor = { priority, id };
  }

  res.json(await adminService.listReports({
    status: status || 'open',
    limit: pageLimit(limit),
    targetType: targetType || null,
    reason: reason || null,
    cursor,
    actorRole: req.user.role
  }));
});

export const report = asyncHandler(async (req, res) => {
  res.json(await adminService.getReport(positiveId(req.params.id, 'report id'), { actorRole: req.user.role }));
});

export const resolveReport = asyncHandler(async (req, res) => {
  const { status, resolution } = req.body ?? {};
  res.json(await adminService.resolveReport(req.user, positiveId(req.params.id, 'report id'), {
    status,
    resolution,
    ip: clientIp(req)
  }));
});

export const reportNotes = asyncHandler(async (req, res) => {
  res.json(await adminService.listReportNotes(positiveId(req.params.id, 'report id'), req.user.role));
});

export const addReportNote = asyncHandler(async (req, res) => {
  const { note } = req.body ?? {};
  res.status(201).json(await adminService.addReportNote(
    req.user,
    positiveId(req.params.id, 'report id'),
    note,
    { ip: clientIp(req) }
  ));
});

export const assignReport = asyncHandler(async (req, res) => {
  const { assigneeId } = req.body ?? {};
  const id = assigneeId === null || assigneeId === '' || assigneeId === undefined
    ? null
    : positiveId(assigneeId, 'assignee id');
  res.json(await adminService.assignReport(
    req.user,
    positiveId(req.params.id, 'report id'),
    id,
    { ip: clientIp(req) }
  ));
});

// ------------------------------------------------------------ user admin

export const users = asyncHandler(async (req, res) => {
  const { q, status, role, limit, offset } = req.query;
  const parsedOffset = optionalInteger(offset, 'offset', { min: 0, max: 1_000_000 }) ?? 0;
  res.json(await adminService.searchUsers({
    q: q || '',
    status: status || null,
    role: role || null,
    limit: pageLimit(limit),
    offset: parsedOffset,
    actorRole: req.user.role
  }));
});

export const user = asyncHandler(async (req, res) => {
  res.json(await adminService.getUserDetail(positiveId(req.params.id, 'user id'), { actorRole: req.user.role }));
});

export const suspend = asyncHandler(async (req, res) => {
  const { days, reason } = req.body ?? {};
  res.json(await adminService.suspendUser(req.user, positiveId(req.params.id, 'user id'), { days, reason, ip: clientIp(req) }));
});

export const ban = asyncHandler(async (req, res) => {
  const { reason } = req.body ?? {};
  res.json(await adminService.banUser(req.user, positiveId(req.params.id, 'user id'), { reason, ip: clientIp(req) }));
});

export const restore = asyncHandler(async (req, res) => {
  const { reason } = req.body ?? {};
  res.json(await adminService.restoreUser(req.user, positiveId(req.params.id, 'user id'), { reason, ip: clientIp(req) }));
});

export const setRole = asyncHandler(async (req, res) => {
  const { role } = req.body ?? {};
  res.json(await adminService.setUserRole(req.user, positiveId(req.params.id, 'user id'), { role, ip: clientIp(req) }));
});

// --------------------------------------------------------- content admin

export const removeContent = asyncHandler(async (req, res) => {
  const { targetType, targetId } = req.body ?? {};
  res.json(await adminService.removeContent(req.user, {
    targetType,
    targetId: positiveId(targetId, 'content id'),
    ip: clientIp(req)
  }));
});

// ----------------------------------------------------- photo-verification queue

export const verifications = asyncHandler(async (req, res) => {
  const before = optionalInteger(req.query.before, 'verification cursor');
  res.json(await adminService.listPendingVerifications({
    limit: pageLimit(req.query.limit),
    before,
    actorRole: req.user.role
  }));
});

export const verificationEvidence = asyncHandler(async (req, res) => {
  const evidence = await adminService.getVerificationEvidence(
    positiveId(req.params.id, 'verification id'), req.user.role
  );
  const extension = path.extname(evidence.filePath).toLowerCase();
  const mime = extension === '.webp' ? 'image/webp' : 'image/jpeg';

  res.status(200);
  const file = await storage.stat(evidence.filePath);
  if (!file) throw notFound('Private verification evidence is no longer available.');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="verification-evidence${extension}"`);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = storage.readStream(evidence.filePath);
  stream.once('error', () => {
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  });
  stream.pipe(res);
});

export const reviewVerification = asyncHandler(async (req, res) => {
  const { decision, note } = req.body ?? {};
  res.json(await adminService.reviewVerification(
    req.user,
    positiveId(req.params.id, 'verification id'),
    { decision, note, ip: clientIp(req) }
  ));
});

// ------------------------------------------------------------ audit/activity

export const auditLog = asyncHandler(async (req, res) => {
  const before = optionalInteger(req.query.before, 'audit cursor');
  const actorId = optionalInteger(req.query.actorId, 'actor id');
  res.json(await adminService.listAuditLog({
    limit: pageLimit(req.query.limit, 50),
    before,
    actorId,
    action: req.query.action || null,
    includeSensitive: hasPermission(req.user.role, 'audit:read_sensitive'),
    actorRole: req.user.role
  }));
});

export const activity = asyncHandler(async (req, res) => {
  const before = optionalInteger(req.query.before, 'activity cursor');
  const subjectUserId = optionalInteger(req.query.subjectUserId, 'subject user id');
  res.json(await adminService.listActivityEvents({
    limit: pageLimit(req.query.limit, 50),
    before,
    eventType: req.query.eventType || null,
    subjectUserId,
    actorRole: req.user.role
  }));
});
