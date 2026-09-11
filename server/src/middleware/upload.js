import multer from 'multer';
import { env } from '../config/env.js';
import { tooLarge, unsupported, badRequest } from '../utils/errors.js';

export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
export const ALLOWED_MIMES = new Set([...IMAGE_MIMES, ...VIDEO_MIMES]);

export const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};

export const MAX_IMAGE_BYTES = env.MAX_IMAGE_MB * 1024 * 1024;
export const MAX_VIDEO_BYTES = env.MAX_VIDEO_MB * 1024 * 1024;
const ABSOLUTE_MAX = Math.max(MAX_IMAGE_BYTES, MAX_VIDEO_BYTES);

/**
 * Memory storage: the buffer is validated by magic bytes and re-encoded before
 * anything is written, so an unvalidated file never lands on disk.
 * (Videos are streamed to a temp file inside the service after validation.)
 */
const storage = multer.memoryStorage();

function fileFilter(_req, file, cb) {
  // The declared mime is only a first gate - real validation is by magic bytes.
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(
      unsupported('That file type is not supported. Use JPG, PNG, WebP, GIF, MP4, WebM or MOV.')
    );
  }
  return cb(null, true);
}

export const uploadSingle = multer({
  storage,
  fileFilter,
  limits: { fileSize: ABSOLUTE_MAX, files: 1, fields: 10 }
}).single('file');

/** Wrap multer so its errors become friendly AppErrors. */
export function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (!err) {
      if (!req.file) return next(badRequest('Choose a file to upload.'));
      return next();
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          tooLarge(
            `That file is too large. Images must be under ${env.MAX_IMAGE_MB} MB and videos under ${env.MAX_VIDEO_MB} MB.`
          )
        );
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(badRequest('Upload one file at a time.'));
      }
      return next(badRequest('That upload could not be processed.'));
    }
    return next(err);
  });
}

/** Avatar/profile-photo uploads: images only, tighter cap. */
export const uploadPhoto = multer({
  storage,
  fileFilter(_req, file, cb) {
    if (!IMAGE_MIMES.has(file.mimetype)) {
      return cb(unsupported('Profile photos must be JPG, PNG, WebP or GIF.'));
    }
    return cb(null, true);
  },
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 }
}).single('photo');

export function handlePhotoUpload(req, res, next) {
  uploadPhoto(req, res, (err) => {
    if (!err) {
      if (!req.file) return next(badRequest('Choose a photo to upload.'));
      return next();
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(tooLarge(`That photo is too large. Keep it under ${env.MAX_IMAGE_MB} MB.`));
    }
    if (err instanceof multer.MulterError) return next(badRequest('That upload could not be processed.'));
    return next(err);
  });
}
