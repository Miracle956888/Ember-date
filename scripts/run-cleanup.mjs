#!/usr/bin/env node
/**
 * One cleanup pass for a hosting-provider cron job. Run from the app root so
 * dotenv/config loads that directory's protected .env file.
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
  const { runCleanup } = await import('../server/src/jobs/cleanup.js');

  const result = await runCleanup({ silent: true });
  if (result?.errorCode) {
    console.error(`[cleanup-cron] failed (${safeCode({ code: result.errorCode })})`);
    exitCode = 1;
  } else {
    console.info(
      `[cleanup-cron] completed; deletedMessages=${Number(result?.deletedMessages || 0)}, ` +
      `deletedFiles=${Number(result?.deletedFiles || 0)}`
    );
  }
} catch (error) {
  // Avoid printing database/provider messages that may contain connection detail.
  console.error(`[cleanup-cron] failed (${safeCode(error)})`);
  exitCode = 1;
} finally {
  if (closePool) {
    try {
      await closePool();
    } catch (error) {
      console.error(`[cleanup-cron] database close failed (${safeCode(error)})`);
      exitCode = 1;
    }
  }
}

process.exitCode = exitCode;
