import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { authLimiter, refreshLimiter, usernameCheckLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post('/register', authLimiter, ctrl.register);
router.post('/login', authLimiter, ctrl.login);
router.post('/refresh', refreshLimiter, ctrl.refresh);
router.post('/logout', ctrl.logout);
router.get('/me', requireAuth, ctrl.me);
router.get('/username-available', usernameCheckLimiter, ctrl.checkUsername);

// Password recovery. Both are unauthenticated by necessity, so they lean on a
// strict limiter and never disclose whether an address is registered.
router.post('/forgot-password', passwordResetLimiter, ctrl.forgotPassword);
router.post('/reset-password', passwordResetLimiter, ctrl.resetPassword);

// CSRF applies to state-changing authed routes elsewhere; logout is safe to call
// without it (it only clears cookies), register/login establish the token pair.
router.use(csrfProtection);

export default router;
