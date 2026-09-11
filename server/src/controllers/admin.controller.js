import { asyncHandler } from '../utils/errors.js';
import * as adminService from '../services/admin.service.js';

/**
 * Admin/moderation endpoints.
 *
 * Authorization is applied at the router (`requireRole`), and the service
 * re-checks rank on every user-targeting action, so these handlers stay thin.
 * Each mutating handler passes `clientIp(req)` down so the audit row records
 * where the action came from.
 */

/** Trust the proxy header only when Express itself has been told to. */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

// ------------------------------------------------------------- analytics

export const overview = asyncHandler(async (_req, res) => {
  res.json(await adminService.analytics());
});

// ---------------------------------------------------------- report queue

export const reports = asyncHandler(async (req, res) => {
  const { status, limit, targetType, reason, cursorPriority, cursorId } = req.query;
  const cursor =
    cursorPriority !== undefined && cursorId !== undefined
      ? { priority: Number(cursorPriority), id: Number(cursorId) }
      : null;

  res.json(
    await adminService.listReports({
      status: status || 'open',
      limit: limit ? Number(limit) : 25,
      targetType: targetType || null,
      reason: reason || null,
      cursor
    })
  );
});

export const report = asyncHandler(async (req, res) => {
  res.json(await adminService.getReport(Number(req.params.id)));
});

export const resolveReport = asyncHandler(async (req, res) => {
  const { status, resolution } = req.body ?? {};
  res.json(
    await adminService.resolveReport(req.user, Number(req.params.id), {
      status,
      resolution,
      ip: clientIp(req)
    })
  );
});

// ------------------------------------------------------------ user admin

export const users = asyncHandler(async (req, res) => {
  const { q, status, role, limit, offset } = req.query;
  res.json(
    await adminService.searchUsers({
      q: q || '',
      status: status || null,
      role: role || null,
      limit: limit ? Number(limit) : 25,
      offset: offset ? Number(offset) : 0
    })
  );
});

export const user = asyncHandler(async (req, res) => {
  res.json(await adminService.getUserDetail(Number(req.params.id)));
});

export const suspend = asyncHandler(async (req, res) => {
  const { days, reason } = req.body ?? {};
  res.json(await adminService.suspendUser(req.user, Number(req.params.id), { days, reason, ip: clientIp(req) }));
});

export const ban = asyncHandler(async (req, res) => {
  const { reason } = req.body ?? {};
  res.json(await adminService.banUser(req.user, Number(req.params.id), { reason, ip: clientIp(req) }));
});

export const restore = asyncHandler(async (req, res) => {
  const { reason } = req.body ?? {};
  res.json(await adminService.restoreUser(req.user, Number(req.params.id), { reason, ip: clientIp(req) }));
});

export const setRole = asyncHandler(async (req, res) => {
  const { role } = req.body ?? {};
  res.json(await adminService.setUserRole(req.user, Number(req.params.id), { role, ip: clientIp(req) }));
});

// --------------------------------------------------------- content admin

export const removeContent = asyncHandler(async (req, res) => {
  const { targetType, targetId, reason } = req.body ?? {};
  res.json(
    await adminService.removeContent(req.user, {
      targetType,
      targetId: Number(targetId),
      reason,
      ip: clientIp(req)
    })
  );
});

// ------------------------------------------------------------ audit log

export const auditLog = asyncHandler(async (req, res) => {
  const { limit, before, actorId, action } = req.query;
  res.json(
    await adminService.listAuditLog({
      limit: limit ? Number(limit) : 50,
      before: before ? Number(before) : null,
      actorId: actorId ? Number(actorId) : null,
      action: action || null
    })
  );
});

/** Lets the client decide whether to render the admin entry point at all. */
export const whoami = asyncHandler(async (req, res) => {
  res.json({ id: req.user.id, role: req.user.role, canAudit: req.user.role === 'admin' });
});
