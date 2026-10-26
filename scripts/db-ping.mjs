#!/usr/bin/env node
/**
 * Read-only database transport check. Uses the same mysql2 pool and TLS policy
 * as the application; it performs no migration or data mutation.
 *
 *   npm run db:ping
 */
let closePool;

try {
  const db = await import('../server/src/db/pool.js');
  closePool = db.closePool;
  await db.assertDbConnection();
  console.log('[db:ping] Read-only MySQL connection check passed.');
} catch (error) {
  const code = error?.code ? ` ${error.code}` : '';
  console.error(`[db:ping] MySQL connection check failed${code}: ${error?.message || 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await closePool?.().catch(() => {});
}
