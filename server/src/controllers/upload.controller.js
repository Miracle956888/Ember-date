import { asyncHandler } from '../utils/errors.js';
import { parseOrThrow, numericIdSchema } from '../utils/validators.js';
import * as uploadService from '../services/upload.service.js';
import { storage } from '../services/storage.service.js';

/** POST /api/uploads - multipart image/video, returns an attachment handle. */
export const createUpload = asyncHandler(async (req, res) => {
  const processed = await uploadService.processUpload({
    buffer: req.file.buffer,
    declaredMime: req.file.mimetype,
    ownerId: req.user.id,
    purpose: 'message'
  });
  const attachment = await uploadService.createAttachment(req.user.id, processed);
  res.status(201).json(attachment);
});

/** POST /api/uploads/social - media for a moment or a 24h post. */
export const createSocialUpload = asyncHandler(async (req, res) => {
  const handle = await uploadService.processSocialUpload({
    buffer: req.file.buffer,
    declaredMime: req.file.mimetype,
    ownerId: req.user.id
  });
  res.status(201).json(handle);
});

/**
 * GET /api/social-media/:name
 * Moment/post media. Authorisation is resolved through the owning content row,
 * so expiry, deletion and blocking all revoke the URL automatically.
 */
export const serveSocialMedia = asyncHandler(async (req, res) => {
  const file = await uploadService.getSocialMediaForViewer(req.params.name, req.user.id);

  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range && file.kind === 'video') {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : file.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= file.size) {
        res.status(416).setHeader('Content-Range', `bytes */${file.size}`);
        return res.end();
      }
      const chunkEnd = Math.min(end, file.size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${file.size}`);
      res.setHeader('Content-Length', String(chunkEnd - start + 1));
      return storage.readStream(file.key, { start, end: chunkEnd }).pipe(res);
    }
  }

  res.setHeader('Content-Length', String(file.size));
  return storage.readStream(file.key).pipe(res);
});

/**
 * GET /api/media/:id[?variant=thumb]
 * Auth-checked: only the two participants of the conversation (or the owner of a
 * not-yet-sent upload) can read the bytes. Supports HTTP range for video.
 */
export const serveMedia = asyncHandler(async (req, res) => {
  const id = parseOrThrow(numericIdSchema, req.params.id);
  const variant = req.query.variant === 'thumb' ? 'thumb' : 'full';
  const file = await uploadService.getAttachmentForViewer(id, req.user.id, variant);

  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Expires-At', file.expiresAt);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range && file.kind === 'video' && variant === 'full') {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : file.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= file.size) {
        res.status(416).setHeader('Content-Range', `bytes */${file.size}`);
        return res.end();
      }
      const chunkEnd = Math.min(end, file.size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${chunkEnd}/${file.size}`);
      res.setHeader('Content-Length', String(chunkEnd - start + 1));
      return storage.readStream(file.key, { start, end: chunkEnd }).pipe(res);
    }
  }

  res.setHeader('Content-Length', String(file.size));
  return storage.readStream(file.key).pipe(res);
});
