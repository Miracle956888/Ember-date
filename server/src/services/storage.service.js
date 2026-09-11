/**
 * Storage abstraction.
 *
 * Everything that touches bytes on disk goes through this module, so swapping
 * to S3 later means implementing the same five methods (`save`, `remove`,
 * `readStream`, `stat`, `publicUrl`) in an S3Storage class and changing the
 * `createStorage()` factory - no call-site changes anywhere else.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('storage');

export class LocalDiskStorage {
  constructor(rootDir) {
    this.root = rootDir;
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.mkdir(path.join(this.root, 'thumbs'), { recursive: true });
    log.info('local disk storage ready', { root: this.root });
  }

  /** Resolve a stored key to an absolute path, refusing traversal outside root. */
  resolve(key) {
    const clean = String(key).replace(/^\/+/, '');
    const abs = path.resolve(this.root, clean);
    const rootWithSep = path.resolve(this.root) + path.sep;
    if (abs !== path.resolve(this.root) && !abs.startsWith(rootWithSep)) {
      throw new Error(`Refusing to access path outside storage root: ${key}`);
    }
    return abs;
  }

  newKey(ext, prefix = '') {
    const safeExt = String(ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const name = `${crypto.randomUUID()}${safeExt ? `.${safeExt}` : ''}`;
    return prefix ? path.posix.join(prefix, name) : name;
  }

  async save(key, buffer) {
    const abs = this.resolve(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buffer, { mode: 0o640 });
    return key;
  }

  async moveInto(tempPath, key) {
    const abs = this.resolve(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    try {
      await fsp.rename(tempPath, abs);
    } catch {
      await fsp.copyFile(tempPath, abs);
      await fsp.unlink(tempPath).catch(() => {});
    }
    return key;
  }

  /** Delete a file. ENOENT is treated as success (idempotent). */
  async remove(key) {
    if (!key) return false;
    try {
      await fsp.unlink(this.resolve(key));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      if (err.message?.startsWith('Refusing to access path')) {
        log.warn('blocked unlink outside root', { key });
        return false;
      }
      throw err;
    }
  }

  async stat(key) {
    try {
      const s = await fsp.stat(this.resolve(key));
      return { size: s.size, mtime: s.mtime };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key) {
    return (await this.stat(key)) !== null;
  }

  readStream(key, options = {}) {
    return fs.createReadStream(this.resolve(key), options);
  }

  async readBuffer(key) {
    return fsp.readFile(this.resolve(key));
  }

  /**
   * Local files are NOT publicly reachable: they are served through the authed
   * /api/media/:id route. Returning the API path keeps the contract identical
   * to a future S3 signed-URL implementation.
   */
  publicUrl(attachmentId, variant) {
    return variant === 'thumb' ? `/api/media/${attachmentId}?variant=thumb` : `/api/media/${attachmentId}`;
  }
}

/*
 * Sketch of the future S3 implementation - same interface:
 *
 * export class S3Storage {
 *   constructor({ bucket, client }) { ... }
 *   async save(key, buffer)  { await this.client.send(new PutObjectCommand({...})); return key; }
 *   async remove(key)        { await this.client.send(new DeleteObjectCommand({...})); return true; }
 *   readStream(key)          { return this.client.send(new GetObjectCommand({...})).Body; }
 *   async stat(key)          { ... HeadObjectCommand ... }
 *   publicUrl(id, variant)   { return getSignedUrl(...); }
 * }
 */

let instance = null;

export function createStorage() {
  if (!instance) instance = new LocalDiskStorage(env.UPLOAD_DIR);
  return instance;
}

export const storage = createStorage();
export default storage;
