import { Router } from 'express';
import * as ctrl from '../controllers/like.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/', ctrl.notifications);
router.get('/unread', ctrl.unread);
router.post('/read', csrfProtection, ctrl.readNotifications);
router.get('/prefs', ctrl.getPrefs);
router.put('/prefs', csrfProtection, ctrl.putPrefs);

export default router;
