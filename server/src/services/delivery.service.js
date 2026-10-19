import crypto from 'node:crypto';
import cron from 'node-cron';
import { execute, queryOne, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import * as emailService from './email.service.js';
import * as smsService from './sms.service.js';

const log = logger.child('delivery');
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 10;
const LEASE_MINUTES = 2;
let task = null;
let draining = false;

function encryptionKey() {
  return crypto.createHmac('sha256', env.JWT.refreshSecret).update('ember-delivery-outbox-v1').digest();
}

function encryptPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptPayload(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.payload_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.payload_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.payload_ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

const VALID_KINDS = new Set(['password_reset', 'email_verification', 'sms_verification']);

/** Queue bearer data only as authenticated ciphertext; never store codes/tokens in plaintext. */
export async function enqueueDelivery(kind, payload) {
  if (!VALID_KINDS.has(kind)) throw new Error('Unsupported delivery kind.');
  const encrypted = encryptPayload(payload);
  const result = await execute(
    `INSERT INTO delivery_outbox (kind, payload_ciphertext, payload_iv, payload_tag)
     VALUES (?, ?, ?, ?)`,
    [kind, encrypted.ciphertext, encrypted.iv, encrypted.tag]
  );
  return Number(result.insertId);
}

async function claimBatch() {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id, kind, payload_ciphertext, payload_iv, payload_tag, attempts
         FROM delivery_outbox
        WHERE (status = 'queued' AND available_at <= NOW())
           OR (status = 'processing' AND last_attempt_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
        ORDER BY id ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`,
      [LEASE_MINUTES]
    );
    if (!rows.length) return [];

    const ids = rows.map((row) => Number(row.id));
    const placeholders = ids.map(() => '?').join(',');
    await conn.execute(
      `UPDATE delivery_outbox
          SET status = 'processing', attempts = attempts + 1, last_attempt_at = NOW()
        WHERE id IN (${placeholders})`,
      ids
    );
    return rows.map((row) => ({ ...row, attempts: Number(row.attempts) + 1 }));
  });
}

async function sendRow(row) {
  const payload = decryptPayload(row);
  if (row.kind === 'password_reset') return emailService.sendPasswordReset(payload);
  if (row.kind === 'email_verification') return emailService.sendVerificationCode({ ...payload, kind: 'email' });
  if (row.kind === 'sms_verification') return smsService.sendVerificationCode(payload);
  return { sent: false, reason: 'unknown_kind' };
}

async function finishRow(row, result) {
  if (result?.sent) {
    // Destroy encrypted bearer data as soon as delivery succeeds.
    await execute(
      `UPDATE delivery_outbox
          SET status = 'sent', sent_at = NOW(), payload_ciphertext = NULL,
              payload_iv = NULL, payload_tag = NULL, last_error_code = NULL
        WHERE id = ?`,
      [row.id]
    );
    return;
  }

  const errorCode = String(result?.reason || 'delivery_failed').slice(0, 40);
  if (row.attempts >= MAX_ATTEMPTS) {
    await execute(
      `UPDATE delivery_outbox
          SET status = 'failed', failed_at = NOW(), last_error_code = ?,
              payload_ciphertext = NULL, payload_iv = NULL, payload_tag = NULL
        WHERE id = ?`,
      [errorCode, row.id]
    );
    log.error('delivery permanently failed; encrypted payload destroyed', { kind: row.kind, code: errorCode });
    return;
  }

  const retryAfterSecs = Math.min(3600, 30 * (2 ** Math.max(0, row.attempts - 1)));
  await execute(
    `UPDATE delivery_outbox
        SET status = 'queued', available_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
            last_error_code = ?
      WHERE id = ?`,
    [retryAfterSecs, errorCode, row.id]
  );
}

/** At-least-once delivery with a short lease; providers may see a duplicate if a process dies after send. */
export async function drainDeliveryOutbox() {
  if (draining) return { skipped: true, processed: 0 };
  draining = true;
  let processed = 0;
  try {
    const rows = await claimBatch();
    for (const row of rows) {
      let result;
      try {
        result = await sendRow(row);
      } catch (error) {
        result = { sent: false, reason: error.name === 'OperationError' ? 'payload_unreadable' : 'delivery_error' };
      }
      await finishRow(row, result);
      processed += 1;
    }
    if (processed) log.info('outbox batch processed', { processed });
    return { skipped: false, processed };
  } finally {
    draining = false;
  }
}

export async function deliveryHealth() {
  const row = await queryOne(
    `SELECT
       SUM(status IN ('queued','processing')) AS pending,
       SUM(status = 'failed') AS failed
     FROM delivery_outbox`
  );
  return {
    pending: Number(row?.pending || 0),
    failed: Number(row?.failed || 0),
    emailConfigured: env.SMTP.configured,
    smsConfigured: env.TWILIO.configured
  };
}

export function startDeliveryJob() {
  if (task) return task;
  task = cron.schedule('* * * * *', () => {
    drainDeliveryOutbox().catch((error) => log.error('outbox run failed', { code: error.code || 'DB_ERROR' }));
  });
  drainDeliveryOutbox().catch((error) => log.error('initial outbox run failed', { code: error.code || 'DB_ERROR' }));
  log.info('delivery outbox scheduled', { everyMinutes: 1 });
  return task;
}

export function stopDeliveryJob() {
  if (task) {
    task.stop();
    task = null;
  }
}
