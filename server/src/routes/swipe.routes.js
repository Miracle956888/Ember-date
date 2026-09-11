import { Router } from 'express';
import * as ctrl from '../controllers/swipe.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { swipeLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.use(requireAuth);

router.post('/', csrfProtection, swipeLimiter, ctrl.createSwipe);
router.post('/rewind', csrfProtection, ctrl.rewind);
router.get('/likes-received', ctrl.likesReceived);

export default router;
