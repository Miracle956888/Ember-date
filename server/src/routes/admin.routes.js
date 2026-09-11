import { Router } from 'express';
import { requireAuth, requireRole, csrfProtection } from '../middleware/auth.js';
import { adminLimiter } from '../middleware/rateLimit.js';
import * as ctrl from '../controllers/admin.controller.js';

/**
 * /api/admin — moderation surface.
 *
 * Two privilege tiers:
 *   moderator — report queue, content takedown, user search, suspend/restore
 *   admin     — everything above, plus bans, role changes and the audit log
 *
 * `requireRole` answers 404 (not 403) for an authenticated non-moderator, so
 * the existence of this surface is not confirmed to a probing account.
 *
 * Literal segments are declared before `/:id` throughout, matching the
 * convention the rest of the routers use.
 */
export const adminRoutes = Router();

adminRoutes.use(requireAuth);
adminRoutes.use(requireRole('moderator'));
adminRoutes.use(adminLimiter);

// -- moderator tier ---------------------------------------------------------

adminRoutes.get('/whoami', ctrl.whoami);
adminRoutes.get('/overview', ctrl.overview);

adminRoutes.get('/reports', ctrl.reports);
adminRoutes.get('/reports/:id', ctrl.report);
adminRoutes.post('/reports/:id/resolve', csrfProtection, ctrl.resolveReport);

adminRoutes.get('/users', ctrl.users);
adminRoutes.get('/users/:id', ctrl.user);
adminRoutes.post('/users/:id/suspend', csrfProtection, ctrl.suspend);
adminRoutes.post('/users/:id/restore', csrfProtection, ctrl.restore);

adminRoutes.post('/content/remove', csrfProtection, ctrl.removeContent);

// -- admin tier -------------------------------------------------------------

adminRoutes.post('/users/:id/ban', csrfProtection, requireRole('admin'), ctrl.ban);
adminRoutes.post('/users/:id/role', csrfProtection, requireRole('admin'), ctrl.setRole);
adminRoutes.get('/audit', requireRole('admin'), ctrl.auditLog);

export default adminRoutes;
