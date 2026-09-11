import { Router } from 'express';
import * as ctrl from '../controllers/match.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

router.get('/', ctrl.listMatches);
router.delete('/:id', csrfProtection, ctrl.unmatch);

export default router;
