#!/usr/bin/env node
/**
 * Drain one encrypted email/SMS delivery-outbox batch from a hosting-provider
 * cron job. Run from the app root so dotenv/config loads its protected .env.
 */
let closePool;
let exitCode = 0;

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_-]{1,40}$/i.test(error.code)
    ? error.code
    : 'JOB_ERROR';
}

try {
  const poolModule = await import('../server/src/db/pool.js');
  closePool = poolModule.closePool;
  const { drainDeliveryOutbox } = await import('../server/src/services/delivery.service.js');

  const result = await drainDeliveryOutbox();
  console.info(`[delivery-cron] completed; processed=${Number(result?.processed || 0)}`);
} catch (error) {
  // Never log message bodies, recipients, tokens, or raw provider/database errors.
  console.error(`[delivery-cron] failed (${safeCode(error)})`);
  exitCode = 1;
} finally {
  if (closePool) {
    try {
      await closePool();
    } catch (error) {
      console.error(`[delivery-cron] database close failed (${safeCode(error)})`);
      exitCode = 1;
    }
  }
}

process.exitCode = exitCode;
