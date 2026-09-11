#!/usr/bin/env node
/**
 * Applies db/schema.sql.
 *
 *   node db/migrate.js            # create database if needed + apply schema
 *   node db/migrate.js --fresh    # DROP DATABASE first, then apply
 *
 * The canonical schema targets MySQL 8 (utf8mb4_0900_ai_ci). When the server it
 * connects to is MariaDB (common for local dev / this sandbox), the statements
 * are transparently rewritten to the nearest MariaDB equivalent so the same
 * file works on both engines.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { env, ROOT_DIR } from '../server/src/config/env.js';

const FRESH = process.argv.includes('--fresh');
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

main().catch((err) => {
  console.error('[migrate] error:', err.message);
  process.exitCode = 1;
});
