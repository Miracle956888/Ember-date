import { Router } from 'express';
import * as ctrl from '../controllers/upload.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { handleUpload } from '../middleware/upload.js';
import { uploadLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.use(requireAuth);

router.post('/', csrfProtection, uploadLimiter, handleUpload, ctrl.createUpload);
router.post('/social', csrfProtection, uploadLimiter, handleUpload, ctrl.createSocialUpload);

export default router;
