import { asyncHandler } from '../utils/errors.js';
import {
  parseOrThrow,
  locationUpdateSchema,
  nearbyQuerySchema,
  bumpedQuerySchema,
  listQuerySchema,
  settingsSchema,
  passportSchema,
  interestsSchema,
  promptsSchema,
  tapSchema,
  favoriteSchema,
  verificationSchema,
  numericIdSchema
} from '../utils/validators.js';
import * as locationService from '../services/location.service.js';
import * as socialService from '../services/social.service.js';
import * as profileService from '../services/profile.service.js';
import * as uploadService from '../services/upload.service.js';
import { storage } from '../services/storage.service.js';
import { getIo } from '../sockets/index.js';
import { logger } from '../utils/logger.js';

const log = logger.child('discovery');

/* ----------------------------------------------------------- location */

export const updateLocation = asyncHandler(async (req, res) => {
  const body = parseOrThrow(locationUpdateSchema, req.body);
  const result = await locationService.updateMyLocation(req.user.id, body);

  // Tell people they just walked past, so "Bumped into" feels live.
  if (result.newEncounters > 0) {
    const io = getIo();
    if (io) {
      const fresh = await locationService.bumpedInto(req.user.id, { limit: result.newEncounters, days: 1 });
      for (const person of fresh.slice(0, result.newEncounters)) {
        io.to(`user:${person.id}`).emit('nearby:bumped', {
          user: {
            id: req.user.id,
            displayName: req.user.displayName,
            username: req.user.username,
            avatarUrl: req.user.avatarUrl
          },
          proximity: person.proximity,
          at: new Date().toISOString()
        });
      }
    }
  }

  res.json(result);
});

export const getLocation = asyncHandler(async (req, res) => {
  const location = await locationService.getMyLocation(req.user.id);
  res.json({ location });
});

export const clearLocation = asyncHandler(async (req, res) => {
  const result = await locationService.clearMyLocation(req.user.id);
  log.info('location cleared', { userId: req.user.id });
  res.json(result);
});

export const nearby = asyncHandler(async (req, res) => {
  const { cursorDistanceKm, cursorId, ...q } = parseOrThrow(nearbyQuerySchema, req.query);
  // Both halves or neither: a half-specified cursor would silently paginate
  // from the wrong place, so it is ignored rather than guessed at.
  const cursor =
    cursorDistanceKm !== undefined && cursorId !== undefined
      ? { distanceKm: cursorDistanceKm, id: cursorId }
      : null;
  res.json(await locationService.peopleNearby(req.user.id, { ...q, cursor }));
});

export const bumped = asyncHandler(async (req, res) => {
  const q = parseOrThrow(bumpedQuerySchema, req.query);
  const results = await locationService.bumpedInto(req.user.id, q);
  res.json({ results, count: results.length });
});

/* ----------------------------------------------------------- settings */

export const getSettings = asyncHandler(async (req, res) => {
  res.json({ settings: await locationService.getSettings(req.user.id) });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const patch = parseOrThrow(settingsSchema, req.body);
  res.json({ settings: await locationService.updateSettings(req.user.id, patch) });
});

export const setPassport = asyncHandler(async (req, res) => {
  const body = parseOrThrow(passportSchema, req.body);
  res.json({ settings: await locationService.setPassport(req.user.id, body) });
});

export const clearPassport = asyncHandler(async (req, res) => {
  res.json({ settings: await locationService.clearPassport(req.user.id) });
});

/* ------------------------------------------------------------- social */

export const likesYou = asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuerySchema, req.query);
  const results = await socialService.likesReceived(req.user.id, q);
  res.json({ results, count: results.length });
});

export const visitors = asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuerySchema, req.query);
  const results = await socialService.visitors(req.user.id, q);
  res.json({ results, count: results.length });
});

export const favorites = asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuerySchema, req.query);
  const results = await socialService.listFavorites(req.user.id, q);
  res.json({ results, count: results.length });
});

export const addFavorite = asyncHandler(async (req, res) => {
  const { targetId } = parseOrThrow(favoriteSchema, req.body);
  res.status(201).json(await socialService.addFavorite(req.user.id, targetId));
});

export const removeFavorite = asyncHandler(async (req, res) => {
  const targetId = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await socialService.removeFavorite(req.user.id, targetId));
});

export const taps = asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuerySchema, req.query);
  const results = await socialService.tapsReceived(req.user.id, q);
  res.json({ results, count: results.length });
});

export const sendTap = asyncHandler(async (req, res) => {
  const { targetId, kind } = parseOrThrow(tapSchema, req.body);
  const result = await socialService.sendTap(req.user.id, targetId, kind);

  const io = getIo();
  if (io && result.isNew) {
    io.to(`user:${targetId}`).emit('tap:received', {
      user: {
        id: req.user.id,
        displayName: req.user.displayName,
        username: req.user.username,
        avatarUrl: req.user.avatarUrl
      },
      kind,
      at: new Date().toISOString()
    });
  }
  res.status(201).json(result);
});

export const markTapsSeen = asyncHandler(async (req, res) => {
  res.json(await socialService.markTapsSeen(req.user.id));
});

export const boost = asyncHandler(async (req, res) => {
  const result = await socialService.startBoost(req.user.id);
  log.info('boost started', { userId: req.user.id });
  res.status(201).json(result);
});

export const boostStatus = asyncHandler(async (req, res) => {
  res.json({ boost: await socialService.activeBoost(req.user.id) });
});

export const topPicks = asyncHandler(async (req, res) => {
  const results = await socialService.topPicks(req.user.id);
  res.json({ results, count: results.length });
});

/** One call for every badge the app shell shows. */
export const counters = asyncHandler(async (req, res) => {
  const [likes, taps, visitors, boost] = await Promise.all([
    socialService.countLikesReceived(req.user.id),
    socialService.countUnseenTaps(req.user.id),
    socialService.countNewVisitors(req.user.id),
    socialService.activeBoost(req.user.id)
  ]);
  res.json({ likes, taps, visitors, boost });
});

/* --------------------------------------------------- interests/prompts */

export const interestCatalogue = asyncHandler(async (_req, res) => {
  res.json({ categories: await profileService.listInterests() });
});

export const myInterests = asyncHandler(async (req, res) => {
  res.json({ interests: await profileService.getUserInterests(req.user.id) });
});

export const setInterests = asyncHandler(async (req, res) => {
  const { slugs } = parseOrThrow(interestsSchema, req.body);
  res.json({ interests: await profileService.setUserInterests(req.user.id, slugs) });
});

export const promptCatalogue = asyncHandler(async (_req, res) => {
  res.json({ prompts: profileService.PROMPT_CATALOGUE });
});

export const myPrompts = asyncHandler(async (req, res) => {
  res.json({ prompts: await profileService.getPrompts(req.user.id) });
});

export const setPrompts = asyncHandler(async (req, res) => {
  const { prompts } = parseOrThrow(promptsSchema, req.body);
  res.json({ prompts: await profileService.setPrompts(req.user.id, prompts) });
});

/* ------------------------------------------------------- verification */

export const verificationChallenge = asyncHandler(async (req, res) => {
  res.json(await profileService.requestVerification(req.user.id));
});

export const verificationStatus = asyncHandler(async (req, res) => {
  res.json(await profileService.getVerificationStatus(req.user.id));
});

export const submitVerification = asyncHandler(async (req, res) => {
  const { gesture } = parseOrThrow(verificationSchema, req.body);
  // The selfie is stored only long enough to be checked, then removed: it is
  // evidence, not profile content, and should not outlive the decision.
  const saved = await uploadService.savePhotoFile(req.user.id, req.file.buffer, req.file.mimetype);
  const result = await profileService.submitVerification(req.user.id, { gesture, filePath: saved.key });

  await storage.remove(saved.key).catch(() => {});
  log.info('verification approved', { userId: req.user.id, gesture });
  res.status(201).json(result);
});
