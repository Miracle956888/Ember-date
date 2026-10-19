#!/usr/bin/env node
/**
 * Ordered, checksummed MySQL migrations.
 *
 *   node db/migrate.js                  # apply pending versions, safely
 *   node db/migrate.js --if-needed      # compatibility alias; also applies pending versions
 *   node db/migrate.js --target=0001     # apply through one exact version (CI/operations only)
 *   node db/migrate.js --fresh          # disposable development DB only; requires two explicit guards
 *
 * Existing installations without migration history are adopted only when all
 * 42 tables and the core baseline columns are present. Adoption records the
 * baseline checksum; it does not replay DDL over live data. DDL auto-commits in
 * MySQL, so a failed version is stopped and must be reconciled before retrying.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { env, ROOT_DIR } from '../server/src/config/env.js';

const MIGRATION_DIR = path.join(ROOT_DIR, 'db', 'migrations');
const MIGRATION_TABLE = 'schema_migrations';
const LOCK_NAME = 'ember-date-schema-migrations';
const BASELINE_FILE = '0001_baseline.sql';
const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const IF_NEEDED = args.includes('--if-needed');
const targetArg = args.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) || null;

/** Split SQL into statements while respecting comments, strings and identifiers. */
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
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** MySQL 8 -> MariaDB compatibility rewrites retained for local deployments. */
export function adaptForMariaDb(statement) {
  return statement
    .replace(/utf8mb4_0900_ai_ci/gi, 'utf8mb4_general_ci')
    .replace(/COLLATE\s*=\s*utf8mb4_0900_as_cs/gi, 'COLLATE=utf8mb4_general_ci');
}

/** Pure decision helper, exported so safety behavior can be tested offline. */
export function decideMigration({
  existingTables = 0,
  hasHistory = false,
  legacyBaselineValid = false,
  pendingCount = 0
} = {}) {
  if (hasHistory) return pendingCount ? { action: 'apply', pendingCount } : { action: 'skip', pendingCount: 0 };
  if (existingTables === 0) return { action: 'apply', pendingCount };
  if (legacyBaselineValid) return { action: 'adopt', pendingCount };
  return { action: 'refuse', existingTables };
}

export function validateContiguousHistory(migrations, appliedVersions) {
  const applied = new Set(appliedVersions);
  const indexes = migrations
    .map((migration, index) => (applied.has(migration.version) ? index : -1))
    .filter((index) => index >= 0);
  const lastAppliedIndex = indexes.length ? Math.max(...indexes) : -1;
  for (let index = 0; index <= lastAppliedIndex; index += 1) {
    if (!applied.has(migrations[index].version)) {
      throw new Error(
        `[migrate] Migration history has a gap before ${migrations[lastAppliedIndex].version}; refusing to apply out of order.`
      );
    }
  }
  return lastAppliedIndex;
}

export async function loadMigrations(directory = MIGRATION_DIR) {
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const migrations = [];
  const seen = new Set();

  for (const filename of files) {
    const match = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/.exec(filename);
    if (!match) throw new Error(`[migrate] Invalid migration filename: ${filename}`);
    const version = match[1];
    if (seen.has(version)) throw new Error(`[migrate] Duplicate migration version: ${version}`);
    seen.add(version);
    const sql = await fs.readFile(path.join(directory, filename), 'utf8');
    migrations.push({
      version,
      name: match[2],
      filename,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      statements: splitStatements(sql)
    });
  }

  if (!migrations.length || migrations[0].filename !== BASELINE_FILE) {
    throw new Error(`[migrate] The first migration must be ${BASELINE_FILE}.`);
  }
  return migrations;
}

const BASELINE_COLUMN_TYPES = new Set([
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC',
  'FLOAT', 'DOUBLE', 'BIT', 'BOOL', 'BOOLEAN', 'DATE', 'TIME', 'YEAR', 'DATETIME',
  'TIMESTAMP', 'CHAR', 'VARCHAR', 'BINARY', 'VARBINARY', 'TINYTEXT', 'TEXT',
  'MEDIUMTEXT', 'LONGTEXT', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'ENUM', 'SET', 'JSON'
]);

/** Expected table columns, parsed from the immutable baseline for legacy adoption checks. */
export function baselineTableColumns(sql) {
  const result = new Map();
  for (const statement of splitStatements(sql)) {
    const tableMatch = /^CREATE TABLE\s+`?([a-zA-Z0-9_]+)`?\s*\(/i.exec(statement);
    if (!tableMatch) continue;
    const tableName = tableMatch[1];
    const open = statement.indexOf('(', tableMatch[0].length - 1);
    const close = statement.lastIndexOf(')');
    if (open < 0 || close <= open) throw new Error(`[migrate] Cannot parse baseline table ${tableName}.`);

    const columns = [];
    for (const line of statement.slice(open + 1, close).split(/\r?\n/)) {
      const columnMatch = /^\s*`?([a-zA-Z][a-zA-Z0-9_]*)`?\s+([a-zA-Z]+)/.exec(line);
      if (columnMatch && BASELINE_COLUMN_TYPES.has(columnMatch[2].toUpperCase())) columns.push(columnMatch[1]);
    }
    result.set(tableName, columns);
  }
  return result;
}

async function getBusinessTables(conn, database) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> ?`,
    [database, MIGRATION_TABLE]
  );
  return rows.map((row) => row.name);
}

async function validateLegacyBaseline(conn, database, migration) {
  const expectedColumns = baselineTableColumns(migration.sql);
  const requiredTables = [...expectedColumns.keys()];
  const existing = new Set(await getBusinessTables(conn, database));
  const missingTables = requiredTables.filter((name) => !existing.has(name));
  if (missingTables.length) {
    throw new Error(
      `[migrate] Existing schema has no migration history and is not a complete baseline. ` +
      `Missing table(s): ${missingTables.join(', ')}. No schema changes were applied.`
    );
  }

  const placeholders = requiredTables.map(() => '?').join(',');
  const [columns] = await conn.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
    [database, ...requiredTables]
  );
  const present = new Set(columns.map((row) => `${row.tableName}.${row.columnName}`));
  const missingColumns = [];
  for (const [tableName, names] of expectedColumns) {
    for (const columnName of names) {
      if (!present.has(`${tableName}.${columnName}`)) missingColumns.push(`${tableName}.${columnName}`);
    }
  }
  if (missingColumns.length) {
    throw new Error(
      `[migrate] Existing schema is missing baseline column(s): ${missingColumns.join(', ')}. ` +
      'No schema changes were applied; reconcile the schema manually and rerun.'
    );
  }
  return true;
}

function parseTarget(migrations, raw) {
  if (!raw) return migrations.length - 1;
  const requested = raw.replace(/\.sql$/, '');
  const index = migrations.findIndex((migration) => migration.version === requested || migration.filename.startsWith(requested));
  if (index < 0) throw new Error(`[migrate] Unknown migration target: ${raw}`);
  return index;
}

async function applyMigration(conn, migration, isMariaDb) {
  const started = Date.now();
  for (let index = 0; index < migration.statements.length; index += 1) {
    const statement = isMariaDb ? adaptForMariaDb(migration.statements[index]) : migration.statements[index];
    try {
      await conn.query(statement);
    } catch (err) {
      throw new Error(
        `[migrate] ${migration.filename} failed at statement ${index + 1}/${migration.statements.length} ` +
        `(${err.code || 'SQL_ERROR'}). MySQL DDL may have auto-committed; inspect the partial change ` +
        'before repairing or retrying.'
      );
    }
  }

  const elapsed = Date.now() - started;
  await conn.execute(
    `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, execution_ms)
     VALUES (?, ?, ?, ?)`,
    [migration.version, migration.name, migration.checksum, String(elapsed)]
  );
  console.log(`[migrate] applied ${migration.version}_${migration.name} (${migration.statements.length} statements, ${elapsed} ms)`);
}

async function assertDestructiveResetAllowed(database) {
  if (env.isProd) throw new Error('[migrate] --fresh is disabled in production. Use an isolated disposable database.');
  if (process.env.ALLOW_DESTRUCTIVE_RESET !== '1' || process.env.CONFIRM_DROP_DATABASE !== database) {
    throw new Error(
      `[migrate] --fresh refused. For an isolated development database only, set ` +
      `ALLOW_DESTRUCTIVE_RESET=1 and CONFIRM_DROP_DATABASE=${database}.`
    );
  }
}

async function main() {
  const database = env.DB.database;
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error(`[migrate] Unsafe database name: ${database}`);
  if (FRESH) await assertDestructiveResetAllowed(database);

  const conn = await mysql.createConnection({
    host: env.DB.host,
    port: env.DB.port,
    user: env.DB.user,
    password: env.DB.password,
    socketPath: env.DB.socketPath,
    ssl: env.DB.ssl,
    multipleStatements: false
  });
  let lockAcquired = false;

  try {
    const [[versionRow]] = await conn.query('SELECT VERSION() AS version');
    const serverVersion = String(versionRow.version);
    const isMariaDb = /mariadb/i.test(serverVersion);
    console.log(`[migrate] server: ${serverVersion}${isMariaDb ? ' (MariaDB compatibility mode)' : ''}`);

    // Acquire the global migration lock before any DDL, including a guarded
    // --fresh database drop, so concurrent runners cannot race the reset path.
    const [[lockRow]] = await conn.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
    if (Number(lockRow.acquired) !== 1) throw new Error('[migrate] Could not acquire the schema-migration lock within 30 seconds.');
    lockAcquired = true;

    if (FRESH) {
      console.warn(`[migrate] destructive reset confirmed for disposable database \`${database}\``);
      await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
    const collation = isMariaDb ? 'utf8mb4_general_ci' : 'utf8mb4_0900_ai_ci';
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE ${collation}`);
    await conn.query(`USE \`${database}\``);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version      VARCHAR(20) NOT NULL,
        name         VARCHAR(100) NOT NULL,
        checksum     CHAR(64) NOT NULL,
        execution_ms INT UNSIGNED NOT NULL DEFAULT 0,
        applied_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${collation}
    `);

    const migrations = await loadMigrations();
    const targetIndex = parseTarget(migrations, targetArg);
    const [history] = await conn.query(`SELECT version, name, checksum FROM ${MIGRATION_TABLE} ORDER BY version`);
    const historyByVersion = new Map(history.map((row) => [row.version, row]));
    const businessTables = await getBusinessTables(conn, database);

    if (history.length === 0 && businessTables.length > 0) {
      const baseline = migrations[0];
      await validateLegacyBaseline(conn, database, baseline);
      await conn.execute(
        `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, execution_ms)
         VALUES (?, ?, ?, 0)`,
        [baseline.version, baseline.name, baseline.checksum]
      );
      historyByVersion.set(baseline.version, {
        version: baseline.version,
        name: baseline.name,
        checksum: baseline.checksum
      });
      console.log(`[migrate] adopted validated legacy baseline ${baseline.version}_${baseline.name}; no baseline DDL replayed`);
    }

    for (const row of history) {
      const migration = migrations.find((entry) => entry.version === row.version);
      if (!migration) throw new Error(`[migrate] Database contains unknown migration ${row.version}; refusing to guess.`);
      if (migration.name !== row.name) {
        throw new Error(`[migrate] Recorded name mismatch for ${row.version}; refusing to guess.`);
      }
      if (migration.checksum !== row.checksum) {
        throw new Error(`[migrate] Checksum mismatch for ${row.version}_${row.name}; applied migration files are immutable.`);
      }
    }

    const baseline = migrations[0];
    if (!historyByVersion.has(baseline.version) && businessTables.length > 0) {
      throw new Error('[migrate] Existing tables were not adopted as a baseline; no schema changes were applied.');
    }

    const lastAppliedIndex = validateContiguousHistory(migrations, historyByVersion.keys());
    if (targetIndex < lastAppliedIndex) {
      throw new Error('[migrate] --target is earlier than an already applied migration.');
    }

    let applied = 0;
    for (const migration of migrations.slice(0, targetIndex + 1)) {
      const recorded = historyByVersion.get(migration.version);
      if (recorded) {
        if (recorded.checksum !== migration.checksum) {
          throw new Error(`[migrate] Checksum mismatch for ${migration.version}_${migration.name}; applied migration files are immutable.`);
        }
        continue;
      }
      if (migration !== baseline && !historyByVersion.has(migrations[migrations.indexOf(migration) - 1]?.version)) {
        throw new Error(`[migrate] Migration ${migration.version} has an unapplied predecessor.`);
      }
      await applyMigration(conn, migration, isMariaDb);
      historyByVersion.set(migration.version, migration);
      applied += 1;
    }

    if (applied === 0) console.log('[migrate] schema is current; no pending migrations');
    if (IF_NEEDED) console.log('[migrate] --if-needed is a compatibility alias; pending migrations were still checked and applied');
    console.log(`[migrate] current version: ${[...historyByVersion.keys()].sort().at(-1) || 'none'}`);
  } finally {
    if (lockAcquired) await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    await conn.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[migrate] error:', err.message);
    process.exitCode = 1;
  });
}
