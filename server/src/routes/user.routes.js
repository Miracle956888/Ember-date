import { Router } from 'express';
import * as ctrl from '../controllers/user.controller.js';
import { requireAuth, optionalAuth, csrfProtection } from '../middleware/auth.js';
import { handlePhotoUpload } from '../middleware/upload.js';
import { uploadLimiter, searchLimiter, usernameCheckLimiter, verifyCodeLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Public: a share link has to work for a signed-out visitor, otherwise /@username
// is useless as a share target. Mounted ABOVE the requireAuth gate. The service
// takes a nullable viewerId and reveals nothing extra to anonymous callers.
router.get('/by-username/:username', optionalAuth, searchLimiter, ctrl.getByUsername);

router.use(requireAuth);

router.get('/deck', ctrl.getDeck);
router.get('/search', searchLimiter, ctrl.searchUsers);
router.get('/me/profile', ctrl.getMyProfile);
router.get('/me/completion', ctrl.completion);

// Identity. Username changes are cooldown-gated; verification codes are
// throttled per-user (10 per 15 min) on top of the service's own per-kind cap.
router.get('/me/username-available', usernameCheckLimiter, ctrl.checkUsername);
router.patch('/me/username', csrfProtection, ctrl.updateUsername);
router.post('/me/verify/start', csrfProtection, verifyCodeLimiter, ctrl.startVerification);
router.post('/me/verify/confirm', csrfProtection, ctrl.confirmVerificationCode);
router.patch('/me', csrfProtection, ctrl.updateMe);
router.post('/me/photos', csrfProtection, uploadLimiter, handlePhotoUpload, ctrl.addPhoto);
router.patch('/me/photos/order', csrfProtection, ctrl.reorderPhotos);
router.delete('/me/photos/:id', csrfProtection, ctrl.deletePhoto);
router.delete('/me', csrfProtection, ctrl.deleteAccount);

// Safety. Kept under /users because both act on a user, not a conversation.
router.get('/blocks', ctrl.blockedList);
router.post('/blocks', csrfProtection, ctrl.block);
router.delete('/blocks/:id', csrfProtection, ctrl.unblock);
router.post('/reports', csrfProtection, ctrl.report);

// Must stay last: ':id' would otherwise swallow the literal paths above.
router.get('/:id', ctrl.getProfile);

export default router;
