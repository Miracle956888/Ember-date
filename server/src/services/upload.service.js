/**
 * Media pipeline: magic-byte validation -> re-encode / EXIF strip -> thumbnail
 * or poster frame -> DB row that inherits the 24h TTL.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { query, queryOne, execute } from '../db/pool.js';
import { storage } from './storage.service.js';
import { env } from '../config/env.js';
import { badRequest, notFound, forbidden, tooLarge, unsupported } from '../utils/errors.js';
import {
  IMAGE_MIMES,
  VIDEO_MIMES,
  EXT_BY_MIME,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES
} from '../middleware/upload.js';
import { logger } from '../utils/logger.js';

const log = logger.child('upload');
const THUMB_WIDTH = 400;

let ffmpegAvailable = null;

/** Probe once whether ffmpeg exists; degrade gracefully when it does not. */
export function checkFfmpeg() {
  if (ffmpegAvailable !== null) return Promise.resolve(ffmpegAvailable);
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => {
      ffmpegAvailable = !err;
      if (err) log.warn('ffmpeg not available - videos will use a generic poster');
      else log.info('ffmpeg available - video posters enabled');
      resolve(ffmpegAvailable);
    });
  });
}

/** Generic branded poster used when ffmpeg is missing or fails. */
async function genericPoster() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7B35A8"/><stop offset="100%" stop-color="#B03A93"/>
    </linearGradient></defs>
    <rect width="640" height="360" fill="url(#g)"/>
    <circle cx="320" cy="180" r="58" fill="#ffffff" opacity="0.92"/>
    <path d="M304 152 L358 180 L304 208 Z" fill="#7B35A8"/>
    <text x="320" y="300" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif"
          font-size="22" font-weight="600" fill="#ffffff" opacity="0.9">Video</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();
}

async function extractPoster(absVideoPath) {
  const ok = await checkFfmpeg();
  if (!ok) return { buffer: await genericPoster(), generic: true, durationSecs: null };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ec-poster-'));
  const outFile = path.join(tmpDir, 'poster.png');

  try {
    const durationSecs = await new Promise((resolve) => {
      ffmpeg.ffprobe(absVideoPath, (err, data) => {
        if (err) return resolve(null);
        const d = data?.format?.duration;
        return resolve(d ? Math.round(Number(d)) : null);
      });
    });

    await new Promise((resolve, reject) => {
      ffmpeg(absVideoPath)
        .on('error', reject)
        .on('end', resolve)
        .screenshots({
          timestamps: ['00:00:01.000'],
          filename: 'poster.png',
          folder: tmpDir,
          size: '640x?'
        });
    });

    const raw = await fsp.readFile(outFile);
    const buffer = await sharp(raw).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    return { buffer, generic: false, durationSecs };
  } catch (err) {
    log.warn('poster extraction failed, using generic', { error: err.message });
    return { buffer: await genericPoster(), generic: true, durationSecs: null };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Validate + process an uploaded buffer and persist it.
 * Returns the attachment row shape used by the API.
 */
export async function processUpload({ buffer, declaredMime, purpose = 'message' }) {
  if (!buffer?.length) throw badRequest('That file appears to be empty.');

  // ---- magic-byte validation (never trust the client header or filename)
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) {
    throw unsupported('We could not recognise that file. Use JPG, PNG, WebP, GIF, MP4, WebM or MOV.');
  }
  const mime = detected.mime;

  const isImage = IMAGE_MIMES.has(mime);
  const isVideo = VIDEO_MIMES.has(mime);
  if (!isImage && !isVideo) {
    throw unsupported('That file type is not supported. Use JPG, PNG, WebP, GIF, MP4, WebM or MOV.');
  }
  if (purpose === 'photo' && !isImage) {
    throw unsupported('Profile photos must be an image.');
  }
  if (declaredMime && declaredMime !== mime && !(declaredMime === 'video/quicktime' && mime === 'video/mp4')) {
    log.debug('declared mime differs from detected', { declaredMime, mime });
  }

  const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (buffer.length > limit) {
    throw tooLarge(
      isImage
        ? `That image is too large. Keep it under ${env.MAX_IMAGE_MB} MB.`
        : `That video is too large. Keep it under ${env.MAX_VIDEO_MB} MB.`
    );
  }

  const kind = isImage ? 'image' : 'video';
  let fileKey;
  let thumbKey = null;
  let width = null;
  let height = null;
  let durationSecs = null;
  let outMime = mime;
  let sizeBytes = buffer.length;

  if (isImage) {
    const isAnimated = mime === 'image/gif';
    const pipeline = sharp(buffer, { animated: isAnimated, failOn: 'none' });
    const meta = await pipeline.metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;

    if (isAnimated) {
      // Keep animation: re-encode to animated webp, which also drops metadata.
      const out = await sharp(buffer, { animated: true, failOn: 'none' })
        .resize({ width: 1600, withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
      outMime = 'image/webp';
      sizeBytes = out.length;
      fileKey = storage.newKey('webp', purpose === 'photo' ? 'photos' : '');
      await storage.save(fileKey, out);

      const thumb = await sharp(buffer, { animated: false, failOn: 'none' })
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      thumbKey = storage.newKey('webp', 'thumbs');
      await storage.save(thumbKey, thumb);
    } else {
      // rotate() applies EXIF orientation then the re-encode strips all metadata.
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer();
      const outMeta = await sharp(out).metadata();
      width = outMeta.width ?? width;
      height = outMeta.height ?? height;
      outMime = 'image/jpeg';
      sizeBytes = out.length;
      fileKey = storage.newKey('jpg', purpose === 'photo' ? 'photos' : '');
      await storage.save(fileKey, out);

      const thumb = await sharp(out)
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      thumbKey = storage.newKey('webp', 'thumbs');
      await storage.save(thumbKey, thumb);
    }
  } else {
    // Video: store as-is (re-encoding 50 MB inline would block), generate poster.
    const ext = EXT_BY_MIME[mime] || 'mp4';
    fileKey = storage.newKey(ext, 'videos');
    await storage.save(fileKey, buffer);

    const abs = storage.resolve(fileKey);
    const poster = await extractPoster(abs);
    durationSecs = poster.durationSecs;
    thumbKey = storage.newKey('webp', 'thumbs');
    await storage.save(thumbKey, poster.buffer);
  }

  return { kind, fileKey, thumbKey, mime: outMime, sizeBytes, width, height, durationSecs };
}

/** Persist an attachment row for a chat upload (message_id filled in on send). */
export async function createAttachment(ownerId, processed) {
  const res = await execute(
    `INSERT INTO attachments
       (message_id, kind, file_path, thumb_path, mime, size_bytes, width, height, duration_secs, owner_id, created_at, expires_at)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [
      processed.kind,
      processed.fileKey,
      processed.thumbKey,
      processed.mime,
      processed.sizeBytes,
      processed.width,
      processed.height,
      processed.durationSecs,
      ownerId,
      env.MESSAGE_TTL_HOURS
    ]
  );
  const id = Number(res.insertId);
  return {
    attachmentId: id,
    kind: processed.kind,
    url: storage.publicUrl(id),
    thumbUrl: processed.thumbKey ? storage.publicUrl(id, 'thumb') : null,
    mime: processed.mime,
    sizeBytes: processed.sizeBytes,
    width: processed.width,
    height: processed.height,
    durationSecs: processed.durationSecs,
    expiresInHours: env.MESSAGE_TTL_HOURS
  };
}

/**
 * Authorised fetch of a media file.
 * Only the two participants of the attachment's conversation may read it, and
 * only while it is unexpired. Unsent uploads are readable by their owner.
 */
export async function getAttachmentForViewer(attachmentId, viewerId, variant = 'full') {
  const row = await queryOne(
    `SELECT a.id, a.kind, a.file_path, a.thumb_path, a.mime, a.size_bytes, a.owner_id,
            a.message_id, a.expires_at, msg.conversation_id, m.user_a_id, m.user_b_id
       FROM attachments a
  LEFT JOIN messages msg     ON msg.id = a.message_id AND msg.expires_at > NOW()
  LEFT JOIN conversations c  ON c.id = msg.conversation_id
  LEFT JOIN matches m        ON m.id = c.match_id
      WHERE a.id = ? AND a.expires_at > NOW()
      LIMIT 1`,
    [attachmentId]
  );
  if (!row) throw notFound('That media has expired.');

  const isOwner = Number(row.owner_id) === viewerId;
  const isParticipant =
    row.user_a_id != null && (Number(row.user_a_id) === viewerId || Number(row.user_b_id) === viewerId);

  if (!isOwner && !isParticipant) {
    throw forbidden('You do not have access to that media.');
  }
  // An attachment already bound to a message must be read via the conversation.
  if (row.message_id && !isParticipant) {
    throw forbidden('You do not have access to that media.');
  }

  const key = variant === 'thumb' && row.thumb_path ? row.thumb_path : row.file_path;
  const mime = variant === 'thumb' && row.thumb_path ? 'image/webp' : row.mime;
  const stat = await storage.stat(key);
  if (!stat) throw notFound('That media has expired.');

  return {
    key,
    mime,
    size: stat.size,
    kind: row.kind,
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

/** Profile photos are public-ish (visible to anyone who can see the profile). */
export async function savePhotoFile(ownerId, buffer, declaredMime) {
  const processed = await processUpload({ buffer, declaredMime, ownerId, purpose: 'photo' });
  // Profile photos live under /uploads/photos and are served by the photo route.
  const photoUrl = (key) => `/api/photos/${encodeURIComponent(path.basename(key))}`;
  return {
    url: photoUrl(processed.fileKey),
    key: processed.fileKey,
    // The 400px rendition is produced for every image upload; it used to be
    // discarded here, which forced every avatar grid to fetch the 1600px file.
    thumbUrl: processed.thumbKey ? photoUrl(processed.thumbKey) : null,
    thumbKey: processed.thumbKey || null
  };
}

/**
 * Remove a stored file by basename, wherever it actually lives.
 *
 * Originals are written to `photos/` but the 400px rendition goes to
 * `thumbs/` (see `savePhotoFile`). Deleting a profile photo used to remove
 * `photos/<name>` for BOTH urls, so every thumbnail was orphaned on disk
 * forever -- a leak, and a breach of the "media is deleted from storage"
 * contract. Try each directory the writer can target.
 */
export async function removeStoredFile(basename) {
  const safe = path.basename(String(basename || ''));
  if (!safe || !/^[A-Za-z0-9._-]+$/.test(safe)) return false;

  for (const key of [`photos/${safe}`, `thumbs/${safe}`, `videos/${safe}`, safe]) {
    if (await storage.exists(key)) {
      await storage.remove(key).catch(() => {});
      return true;
    }
  }
  return false;
}

export async function findPhotoKeyByBasename(basename) {
  const safe = path.basename(String(basename));
  if (!/^[A-Za-z0-9._-]+$/.test(safe)) throw badRequest('Invalid photo reference.');
  const key = path.posix.join('photos', safe);
  const stat = await storage.stat(key);
  if (!stat) throw notFound('Photo not found.');
  return { key, size: stat.size };
}

/**
 * Authorised profile-photo lookup.
 *
 * `findPhotoKeyByBasename` only proves the file exists on disk. Profile photos
 * are personal media, so knowing (or having once been shown) a filename must
 * not grant permanent access. We resolve the basename back to its owner and
 * refuse the read when either side has blocked the other.
 *
 * Rules:
 *  - your own photos: always readable;
 *  - an orphan file with no owning row: 404 (deleted photos stay deleted);
 *  - a block in either direction: 404, never 403, so the response cannot be
 *    used to confirm that a specific person blocked you.
 */
export async function getPhotoForViewer(basename, viewerId) {
  const safe = path.basename(String(basename));
  if (!/^[A-Za-z0-9._-]+$/.test(safe)) throw badRequest('Invalid photo reference.');

  const url = `/api/photos/${safe}`;
  const owner = await queryOne(
    `SELECT p.user_id
       FROM user_photos p
      WHERE p.url = ? OR p.thumb_url = ?
      UNION
     SELECT u.id AS user_id
       FROM users u
      WHERE u.avatar_url = ?
      LIMIT 1`,
    [url, url, url]
  );

  // No owning row: the photo was deleted or never belonged to a profile.
  if (!owner) throw notFound('Photo not found.');

  const ownerId = Number(owner.user_id);
  if (ownerId !== Number(viewerId)) {
    const blocked = await queryOne(
      `SELECT 1 AS x FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
        LIMIT 1`,
      [viewerId, ownerId, ownerId, viewerId]
    );
    if (blocked) throw notFound('Photo not found.');
  }

  let key = path.posix.join('photos', safe);
  let stat = await storage.stat(key);
  if (!stat) {
    key = path.posix.join('thumbs', safe);
    stat = await storage.stat(key);
  }
  if (!stat) throw notFound('Photo not found.');
  return { key, size: stat.size, ownerId };
}

export async function deleteAttachmentsByIds(ids) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const rows = await query(`SELECT file_path, thumb_path FROM attachments WHERE id IN (${ph})`, ids);
  for (const r of rows) {
    await storage.remove(r.file_path).catch(() => {});
    if (r.thumb_path) await storage.remove(r.thumb_path).catch(() => {});
  }
  const res = await execute(`DELETE FROM attachments WHERE id IN (${ph})`, ids);
  return res.affectedRows;
}

export function newUploadToken() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ *
 * Social media (moments + posts)
 *
 * Chat attachments live in the `attachments` table and are authorised through
 * the conversation. Moment/post media is different: it is owned by the moment
 * or post row itself, so it gets its own key-addressed route. The URL contains
 * only an opaque UUID basename, and the route re-checks liveness + blocking on
 * every read — an old URL stops working the instant the content expires.
 * ------------------------------------------------------------------ */

/** Public URL for a social media key. Keys are UUIDs, so they are unguessable. */
export function socialUrl(key) {
  return key ? `/api/social-media/${path.posix.basename(key)}` : null;
}

/**
 * Run the standard media pipeline and return a handle for `socialMediaSchema`.
 * No DB row is written here: the moment/post insert owns the keys, which keeps
 * orphan cleanup a single job over one table instead of two.
 */
export async function processSocialUpload({ buffer, declaredMime, ownerId }) {
  const processed = await processUpload({ buffer, declaredMime, ownerId, purpose: 'social' });
  return {
    kind: processed.kind === 'video' ? 'video' : 'photo',
    url: socialUrl(processed.fileKey),
    thumbUrl: socialUrl(processed.thumbKey),
    fileKey: processed.fileKey,
    thumbKey: processed.thumbKey,
    width: processed.width,
    height: processed.height,
    durationSecs: processed.durationSecs
  };
}

/**
 * Authorise a read of moment/post media by its basename.
 *
 * Ownership is resolved through the content row, so all four of the audit's
 * requirements hold at once: expired content is unreachable, blocked users are
 * refused, deleted content 404s, and the URL itself grants nothing.
 */
export async function getSocialMediaForViewer(basename, viewerId) {
  const safe = path.posix.basename(String(basename));
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/i.test(safe)) throw notFound('That media is no longer available.');

  const [{ ownerOfMedia: momentOwner }, { ownerOfMedia: postOwner }] = await Promise.all([
    import('./moment.service.js'),
    import('./post.service.js')
  ]);

  const owner = (await momentOwner(safe, viewerId)) || (await postOwner(safe, viewerId));
  if (!owner) throw notFound('That media is no longer available.');

  // Find the real key: the basename may be the full file or its thumbnail.
  const candidates = [safe, `videos/${safe}`, `thumbs/${safe}`, `photos/${safe}`];
  let key = null;
  for (const c of candidates) {
    if (await storage.exists(c)) {
      key = c;
      break;
    }
  }
  if (!key) throw notFound('That media is no longer available.');

  const stat = await storage.stat(key);
  const ext = path.extname(key).slice(1).toLowerCase();
  const mime =
    { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext] ||
    'application/octet-stream';

  return { key, mime, size: stat.size, kind: mime.startsWith('video/') ? 'video' : 'photo' };
}
