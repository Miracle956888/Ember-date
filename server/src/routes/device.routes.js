import { Router } from 'express';
import * as crypto from '../controllers/crypto.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

// A device publishes its PUBLIC key only. The private half never leaves the
// browser, so there is nothing here the server could decrypt with.
router.post('/', csrfProtection, crypto.registerDevice);
router.get('/', crypto.listMyDevices);
router.delete('/:deviceId', csrfProtection, crypto.revokeDevice);

export default router;
