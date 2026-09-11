import { Router } from 'express';
import * as ctrl from '../controllers/discovery.controller.js';
import { requireAuth, csrfProtection } from '../middleware/auth.js';
import { handlePhotoUpload } from '../middleware/upload.js';
import { uploadLimiter, searchLimiter, locationLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.use(requireAuth);

/* Location ---------------------------------------------------------- */
router.get('/location', ctrl.getLocation);
router.post('/location', csrfProtection, locationLimiter, ctrl.updateLocation);
router.delete('/location', csrfProtection, ctrl.clearLocation);

/* Discovery surfaces ------------------------------------------------ */
router.get('/nearby', searchLimiter, ctrl.nearby);
router.get('/bumped', searchLimiter, ctrl.bumped);
router.get('/top-picks', ctrl.topPicks);

/* Interest / attention lists ---------------------------------------- */
router.get('/likes-you', ctrl.likesYou);
router.get('/visitors', ctrl.visitors);
router.get('/counters', ctrl.counters);

router.get('/favorites', ctrl.favorites);
router.post('/favorites', csrfProtection, ctrl.addFavorite);
router.delete('/favorites/:id', csrfProtection, ctrl.removeFavorite);

router.get('/taps', ctrl.taps);
router.post('/taps', csrfProtection, ctrl.sendTap);
router.post('/taps/seen', csrfProtection, ctrl.markTapsSeen);

/* Boost -------------------------------------------------------------- */
router.get('/boost', ctrl.boostStatus);
router.post('/boost', csrfProtection, ctrl.boost);

/* Settings, filters, passport ---------------------------------------- */
router.get('/settings', ctrl.getSettings);
router.patch('/settings', csrfProtection, ctrl.updateSettings);
router.post('/passport', csrfProtection, ctrl.setPassport);
router.delete('/passport', csrfProtection, ctrl.clearPassport);

/* Interests and prompts ----------------------------------------------- */
router.get('/interests', ctrl.interestCatalogue);
router.get('/me/interests', ctrl.myInterests);
router.put('/me/interests', csrfProtection, ctrl.setInterests);
router.get('/prompts', ctrl.promptCatalogue);
router.get('/me/prompts', ctrl.myPrompts);
router.put('/me/prompts', csrfProtection, ctrl.setPrompts);

/* Verification --------------------------------------------------------- */
router.get('/verification', ctrl.verificationStatus);
router.get('/verification/challenge', ctrl.verificationChallenge);
router.post(
  '/verification',
  csrfProtection,
  uploadLimiter,
  handlePhotoUpload,
  ctrl.submitVerification
);

export default router;
