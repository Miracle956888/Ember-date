/**
 * crypto.controller — device keys, conversation keys and the chat timer.
 * Every handler is participation-checked inside the service layer.
 */
import * as cryptoService from '../services/crypto.service.js';
import * as ttlService from '../services/ttl.service.js';
import { createSystemMessage } from '../services/message.service.js';
import { getIo } from '../sockets/index.js';
import { asyncHandler } from '../utils/errors.js';
import {
  parseOrThrow,
  numericIdSchema,
  registerDeviceSchema,
  publishKeysSchema,
  deviceIdSchema,
  setTimerSchema
} from '../utils/validators.js';

/* ---------------------------- device keys ---------------------------- */

export const registerDevice = asyncHandler(async (req, res) => {
  const data = parseOrThrow(registerDeviceSchema, req.body);
  const device = await cryptoService.registerDevice(req.user.id, data);
  res.status(201).json({ device });
});

export const listMyDevices = asyncHandler(async (req, res) => {
  const devices = await cryptoService.listDevices(req.user.id);
  res.json({ devices });
});

export const revokeDevice = asyncHandler(async (req, res) => {
  const deviceId = parseOrThrow(deviceIdSchema, req.params.deviceId);
  const result = await cryptoService.revokeDevice(req.user.id, deviceId);
  res.json(result);
});

/* ------------------------- conversation keys ------------------------- */

/** Public keys of every active device on both sides, for sealing a key to. */
export const conversationDevices = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const devices = await cryptoService.conversationDeviceKeys(conversationId, req.user.id);
  res.json({ devices });
});

export const publishKeys = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const data = parseOrThrow(publishKeysSchema, req.body);
  const result = await cryptoService.publishConversationKey(conversationId, req.user.id, data);

  // Tell the other side a new key generation exists so their open tab can
  // fetch and unwrap it without waiting for a reload.
  const io = getIo();
  if (io) io.to(`conv:${conversationId}`).emit('chat:key:published', { conversationId, keyId: result.keyId });

  res.status(201).json(result);
});

export const myKeys = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const deviceId = parseOrThrow(deviceIdSchema, req.query.deviceId);
  const keys = await cryptoService.myConversationKeys(conversationId, req.user.id, deviceId);
  res.json({ keys });
});

export const keyCoverage = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const coverage = await cryptoService.keyCoverage(conversationId, req.user.id);
  res.json(coverage);
});

/* ------------------------------ timers ------------------------------ */

export const getTimer = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  res.json(await ttlService.getTimer(conversationId, req.user.id));
});

export const setTimer = asyncHandler(async (req, res) => {
  const conversationId = parseOrThrow(numericIdSchema, req.params.id);
  const { ttlHours } = parseOrThrow(setTimerSchema, req.body);
  const result = await ttlService.setTimer(conversationId, req.user.id, ttlHours);

  // A timer change is never silent: it lands in the thread as a system message
  // so both people can see who changed it and when.
  if (result.changed) {
    const note = await createSystemMessage(
      conversationId,
      req.user.id,
      `${req.user.displayName || 'Someone'} set messages to disappear after ${result.label}. This applies to new messages only.`
    );
    const io = getIo();
    if (io) {
      io.to(`conv:${conversationId}`).emit('chat:message', note);
      io.to(`conv:${conversationId}`).emit('chat:timer', {
        conversationId,
        ttlHours: result.ttlHours,
        label: result.label
      });
    }
  }

  res.json(result);
});
