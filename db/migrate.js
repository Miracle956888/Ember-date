#!/usr/bin/env node
/**
 * Applies db/schema.sql.
 *
 *   node db/migrate.js              # apply to an empty database; REFUSE if one exists
 *   node db/migrate.js --if-needed  # no-op when a schema exists (what the image runs at boot)
 *   node db/migrate.js --fresh      # DROP DATABASE first, then apply (needs that privilege)
 *
 * Read this before wiring it into anything: db/schema.sql is a snapshot, not an
 * additive migration. It DROPs and recreates 23 of the 42 tables - users,
 * messages, chats, photos, the ones holding everything - and the remaining 19
 * (posts, moments, notifications, ...) are created unconditionally, so a second
 * run does not "just skip them": it aborts partway with ER_TABLE_EXISTS_ERROR and
 * leaves the foreign keys pointing at the freshly emptied tables. Re-running this
 * file against a live database is therefore never safe, which is why the default
 * mode refuses and why container boot uses --if-needed: first boot provisions the
 * schema, every restart after it is a no-op.
 *
 * There is no versioned-migration system yet. To change an existing production
 * schema, apply ALTER statements by hand (mysql client, or the provider's shell).
 *
 * The canonical schema targets MySQL 8 (utf8mb4_0900_ai_ci). When the server it
 * connects to is MariaDB (common for local dev / this sandbox), the statements
 * are transparently rewritten to the nearest MariaDB equivalent so the same
 * file works on both engines.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env, ROOT_DIR } from '../server/src/config/env.js';

const FRESH = process.argv.includes('--fresh');
const IF_NEEDED = process.argv.includes('--if-needed');
const SCHEMA_PATH = path.join(ROOT_DIR, 'db', 'schema.sql');

/** Split a SQL file into statements, ignoring `--` comments and respecting quotes. */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (ch === '#') {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
    }

    if (ch === "'" && !inDouble && !inBacktick && sql[i - 1] !== '\\') inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick && sql[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** MySQL 8 -> MariaDB compatibility rewrites. */
export function adaptForMariaDb(statement) {
  return statement
    .replace(/utf8mb4_0900_ai_ci/gi, 'utf8mb4_general_ci')
    .replace(/COLLATE\s*=\s*utf8mb4_0900_as_cs/gi, 'COLLATE=utf8mb4_general_ci');
}

/**
 * Decide what to do about a schema that may already exist. Pure and exported so
 * scripts/dep-smoke.mjs can prove the boot contract without a database: the image
 * start command calls migrate on EVERY start, and the schema it applies destroys
 * data, so "apply" twice must never be reachable.
 */
export function decideMigration({ existingTables = 0, fresh = false, ifNeeded = false } = {}) {
  if (existingTables === 0) return { action: 'apply', existingTables, destructive: false };
  // --fresh dropped the whole database a moment ago, so there is nothing left for
  // the guard to protect. Deliberately the only way to get here on a populated DB:
  // a flag that says "recreate anyway" would be one typo away from data loss.
  if (fresh) return { action: 'apply', existingTables, destructive: false };
  if (ifNeeded) return { action: 'skip', existingTables };
  return { action: 'refuse', existingTables };
}

async function main() {
  const serverConn = await mysql.createConnection({
    host: env.DB.host,
    port: env.DB.port,
    user: env.DB.user,
    password: env.DB.password,
    socketPath: env.DB.socketPath,
    multipleStatements: false
  });

  const [[verRow]] = await serverConn.query('SELECT VERSION() AS v');
  const version = String(verRow.v);
  const isMariaDb = /mariadb/i.test(version);
  console.log(`[migrate] server: ${version}${isMariaDb ? ' (MariaDB compatibility mode)' : ''}`);

  const dbName = env.DB.database;
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`[migrate] Unsafe database name: ${dbName}`);
  }

  if (FRESH) {
    console.log(`[migrate] dropping database \`${dbName}\``);
    await serverConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  }

  const collation = isMariaDb ? 'utf8mb4_general_ci' : 'utf8mb4_0900_ai_ci';
  await serverConn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE ${collation}`
  );
  await serverConn.query(`USE \`${dbName}\``);

  const [existing] = await serverConn.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [dbName]
  );
  const decision = decideMigration({
    existingTables: Number(existing[0].n),
    fresh: FRESH,
    ifNeeded: IF_NEEDED
  });

  if (decision.action === 'skip') {
    console.log(
      `[migrate] ${decision.existingTables} table(s) already present in \`${dbName}\` - leaving them alone (--if-needed)`
    );
    await serverConn.end();
    return;
  }
  if (decision.action === 'refuse') {
    await serverConn.end();
    throw new Error(
      `[migrate] \`${dbName}\` already has ${decision.existingTables} table(s) and db/schema.sql is not re-runnable: ` +
      'it DROPs and recreates 23 tables (deleting that data) then aborts on the other 19. ' +
      'Use --if-needed to no-op when a schema exists (what container boot does), or --fresh ' +
      'to drop the database and rebuild it from the snapshot. To evolve a live schema, apply ' +
      'ALTER statements by hand - there is no versioned migration system yet.'
    );
  }
  if (FRESH) {
    console.warn(`[migrate] rebuilding \`${dbName}\` from the schema snapshot (--fresh); every table is recreated empty`);
  }

  const raw = await fs.readFile(SCHEMA_PATH, 'utf8');
  const statements = splitStatements(raw);

  let applied = 0;
  for (const stmt of statements) {
    const sql = isMariaDb ? adaptForMariaDb(stmt) : stmt;
    try {
      await serverConn.query(sql);
      applied += 1;
    } catch (err) {
      console.error(`\n[migrate] FAILED statement:\n${sql}\n`);
      throw err;
    }
  }

  const [tables] = await serverConn.query(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [dbName]
  );

  console.log(`[migrate] applied ${applied} statements`);
  console.log(`[migrate] tables: ${tables.map((t) => t.name).join(', ')}`);
  console.log('[migrate] done');
  await serverConn.end();
}

// Run only when invoked as a script. scripts/dep-smoke.mjs imports decideMigration
// from this file to test the boot contract, and importing must not open a
// connection to a database that may hold live data.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[migrate] error:', err.message);
    process.exitCode = 1;
  });
}
