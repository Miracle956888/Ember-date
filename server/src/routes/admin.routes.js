import { Router } from 'express';
import { requireAuth, requirePermission, csrfProtection } from '../middleware/auth.js';
import { adminLimiter } from '../middleware/rateLimit.js';
import * as ctrl from '../controllers/admin.controller.js';

/** Server-enforced permission boundary for the staff control center. */
export const adminRoutes = Router();

adminRoutes.use(requireAuth);
adminRoutes.use(adminLimiter);

adminRoutes.get('/whoami', requirePermission('admin:access'), ctrl.whoami);
adminRoutes.get('/overview', requirePermission('analytics:read'), ctrl.overview);
adminRoutes.get('/health', requirePermission('system:health'), ctrl.health);
adminRoutes.get('/settings', requirePermission('system:read'), ctrl.settings);

adminRoutes.get('/reports', requirePermission('reports:read'), ctrl.reports);
adminRoutes.get('/reports/:id', requirePermission('reports:read'), ctrl.report);
adminRoutes.get('/reports/:id/notes', requirePermission('reports:notes'), ctrl.reportNotes);
adminRoutes.post('/reports/:id/notes', csrfProtection, requirePermission('reports:notes'), ctrl.addReportNote);
adminRoutes.post('/reports/:id/assign', csrfProtection, requirePermission('reports:manage'), ctrl.assignReport);
adminRoutes.post('/reports/:id/resolve', csrfProtection, requirePermission('reports:manage'), ctrl.resolveReport);

adminRoutes.get('/users', requirePermission('users:read_basic'), ctrl.users);
adminRoutes.get('/users/:id', requirePermission('users:read_detail'), ctrl.user);
adminRoutes.post('/users/:id/suspend', csrfProtection, requirePermission('users:suspend'), ctrl.suspend);
adminRoutes.post('/users/:id/restore', csrfProtection, requirePermission('users:restore'), ctrl.restore);
adminRoutes.post('/users/:id/ban', csrfProtection, requirePermission('users:ban'), ctrl.ban);
adminRoutes.post('/users/:id/role', csrfProtection, requirePermission('roles:manage'), ctrl.setRole);

adminRoutes.post('/content/remove', csrfProtection, requirePermission('content:remove'), ctrl.removeContent);

adminRoutes.get('/verifications', requirePermission('verification:read'), ctrl.verifications);
adminRoutes.get('/verifications/:id/evidence', requirePermission('verification:review'), ctrl.verificationEvidence);
adminRoutes.post('/verifications/:id/review', csrfProtection, requirePermission('verification:review'), ctrl.reviewVerification);

adminRoutes.get('/audit', requirePermission('audit:read'), ctrl.auditLog);
adminRoutes.get('/activity', requirePermission('activity:read'), ctrl.activity);

export default adminRoutes;
