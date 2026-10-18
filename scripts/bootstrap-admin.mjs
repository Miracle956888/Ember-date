#!/usr/bin/env node
/**
 * One-time, audited first-admin bootstrap for a newly migrated database.
 *
 *   BOOTSTRAP_ADMIN_USERNAME=your_handle npm run admin:bootstrap
 *
 * Refuses when any admin/super-admin role already exists. This is a controlled
 * recovery path, not a general role-management command.
 */
import { pool } from '../server/src/db/pool.js';

const username = String(process.env.BOOTSTRAP_ADMIN_USERNAME || '').trim().toLowerCase();
const LOCK_NAME = 'ember-date-initial-admin-bootstrap';

function assertRequestedUsername() {
  if (!/^[a-z0-9](?:[a-z0-9._]{1,28}[a-z0-9])$/.test(username)) {
    throw new Error('[bootstrap-admin] Set BOOTSTRAP_ADMIN_USERNAME to the existing account handle (3–30 lowercase letters, digits, dots or underscores).');
  }
}

async function main() {
  assertRequestedUsername();
  const conn = await pool.getConnection();
  let lockAcquired = false;
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('[bootstrap-admin] Could not acquire the bootstrap lock.');
    lockAcquired = true;
    await conn.beginTransaction();

    const [migrationRows] = await conn.execute(
      'SELECT version FROM schema_migrations WHERE version = ? LIMIT 1', ['0003']
    );
    if (!migrationRows.length) throw new Error('[bootstrap-admin] Apply all current database migrations through 0003 before bootstrapping staff.');

    const [administrators] = await conn.execute(
      "SELECT id FROM users WHERE role IN ('admin','super_admin') LIMIT 1 FOR UPDATE"
    );
    if (administrators.length) throw new Error('[bootstrap-admin] An administrator role already exists; use the audited admin console.');

    const [users] = await conn.execute(
      'SELECT id, username, role, status FROM users WHERE username = ? LIMIT 1 FOR UPDATE', [username]
    );
    const target = users[0];
    if (!target) throw new Error('[bootstrap-admin] No account matches that handle. Create and verify the account first.');
    if (target.status !== 'active') throw new Error('[bootstrap-admin] The selected account is not active.');
    if (target.role === 'admin' || target.role === 'super_admin') {
      throw new Error('[bootstrap-admin] The selected account already has an administrator role.');
    }

    await conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", [target.id]);
    await conn.execute(
      `INSERT INTO admin_audit_log
         (actor_id, actor_username, action, target_type, target_id, detail, ip)
       VALUES (NULL, 'system/bootstrap', 'admin.bootstrap', 'user', ?,
               'Initial administrator role assigned by one-time bootstrap.', NULL)`,
      [target.id]
    );
    await conn.execute(
      `INSERT INTO activity_events
         (event_type, outcome, actor_id, actor_username, actor_role,
          subject_user_id, resource_type, resource_id, source, metadata)
       VALUES ('admin.bootstrap', 'info', NULL, 'system/bootstrap', 'bootstrap', ?, 'user', ?, 'bootstrap', NULL)`,
      [target.id, target.id]
    );
    await conn.commit();
    console.log(`[bootstrap-admin] @${target.username} is now the initial administrator. Sign out and back in to refresh the session.`);
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    if (lockAcquired) await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
