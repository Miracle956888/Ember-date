import { Router } from 'express';
import * as ctrl from '../controllers/message.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { messageLimiter } from '../middleware/rateLimit.js';
import { getConversation } from '../controllers/match.controller.js';
import * as crypto from '../controllers/crypto.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/:id', getConversation);
router.get('/:id/messages', ctrl.listMessages);
router.post('/:id/messages', csrfProtection, messageLimiter, ctrl.sendMessage);
router.delete('/:id/messages', csrfProtection, ctrl.clearChat);
router.post('/:id/read', csrfProtection, ctrl.markRead);

// Location sharing inside a conversation.
router.post('/:id/location', csrfProtection, messageLimiter, ctrl.shareLocation);
router.patch('/:id/location/:messageId', csrfProtection, ctrl.updateLiveLocation);
router.delete('/:id/location/:messageId', csrfProtection, ctrl.stopLiveLocation);

// Pre-send safety advisory (no side effects).
router.post('/:id/check', csrfProtection, ctrl.checkMessage);

// E2EE key exchange for this conversation. The server brokers public keys and
// stores sealed blobs; it never holds anything it could decrypt.
router.get('/:id/devices', crypto.conversationDevices);
router.get('/:id/keys', crypto.myKeys);
router.get('/:id/keys/coverage', crypto.keyCoverage);
router.post('/:id/keys', csrfProtection, crypto.publishKeys);

// Custom disappearing-message timer.
router.get('/:id/timer', crypto.getTimer);
router.put('/:id/timer', csrfProtection, crypto.setTimer);

export default router;
