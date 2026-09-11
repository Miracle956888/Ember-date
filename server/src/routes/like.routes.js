import { Router } from 'express';
import * as ctrl from '../controllers/like.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { likeLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.use(requireAuth);

// A dedicated limiter: likes are cheap and bursty, unlike post creation.
router.post('/', csrfProtection, likeLimiter, ctrl.create);
router.post('/toggle', csrfProtection, likeLimiter, ctrl.toggle);
router.delete('/:targetType/:targetId', csrfProtection, likeLimiter, ctrl.remove);

// Literal paths must precede the parameterised ones.
router.get('/:targetType/:targetId/likers', ctrl.listLikers);
router.get('/:targetType/:targetId', ctrl.status);

export default router;
