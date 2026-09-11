import mysql from 'mysql2/promise';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('db');

export const pool = mysql.createPool({
  host: env.DB.host,
  port: env.DB.port,
  user: env.DB.user,
  password: env.DB.password,
  database: env.DB.database,
  socketPath: env.DB.socketPath,
  waitForConnections: true,
  connectionLimit: env.DB.connectionLimit,
  maxIdle: env.DB.connectionLimit,
  idleTimeout: 60_000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  charset: 'utf8mb4_general_ci',
  timezone: 'Z',
  dateStrings: false,
  namedPlaceholders: false,
  supportBigNumbers: true,
  bigNumberStrings: false
});

/**
 * Pin every pooled connection to UTC.
 *
 * The driver parses DATETIME as UTC (`timezone: 'Z'` above), so the SERVER
 * session must be UTC too or every timestamp is skewed by the host's offset.
 * MySQL defaults to `time_zone = SYSTEM`, i.e. the OS clock, and all 126 of
 * our expiry comparisons run off the DB clock via NOW(). On a host at UTC-8 a
 * "24 hour" message written as NOW() + INTERVAL 24 HOUR reads back in Node as
 * expiring in 16 hours: the ephemerality contract silently broken by where the
 * app happens to be deployed. Proven with tmp/p10-i18n.mjs.
 *
 * mysql2 has no `initSql`/`init_command` option (passing one is ignored with a
 * warning), so this hooks the pool's `connection` event, which fires once per
 * physical connection before it is handed out.
 */
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (err) log.error('failed to pin session time_zone to UTC', { error: err.message });
  });
});

/**
 * Make integer parameters safe for MySQL 8.0.22+ prepared statements.
 *
 * mysql2 serialises every JS `Number` as MYSQL_TYPE_DOUBLE. Since 8.0.22 the
 * server validates parameter types against what the prepared statement
 * expects, and while it will coerce a *string* to an integer it refuses to
 * coerce a double, answering:
 *
 *     Error: Incorrect arguments to mysqld_stmt_execute
 *
 * The classic victim is `LIMIT ?` (we have 19 of them), because LIMIT demands
 * an exact integer -- so every feed, every paginated list and the deck died on
 * MySQL 8 while working perfectly on MariaDB, which still coerces silently.
 * That difference is exactly why the whole test suite stayed green: the CI
 * database is MariaDB and the user's is MySQL 8 on Windows.
 *
 * Sending safe integers as strings is the fix the mysql2 maintainer recommends
 * for this (sidorares/node-mysql2#1239, discussion #2652). It is lossless:
 * MySQL parses the string back to an integer for INT/BIGINT/LIMIT columns, and
 * for a string column an integer would have been stringified anyway.
 *
 * Deliberately narrow:
 * - only finite SAFE integers convert, so nothing large loses precision;
 * - floats (lat/lng, distances) are untouched -- they really are DOUBLEs and
 *   the server expects a double there;
 * - null/undefined/Date/Buffer/boolean are untouched;
 * - BigInt is sent as its decimal string, which MySQL reads exactly.
 *
 * Applied centrally so no future `LIMIT ?` can reintroduce the bug.
 */
export function coerceParams(params) {
  if (!Array.isArray(params)) return params;
  let changed = false;
  const out = params.map((p) => {
    if (typeof p === 'number' && Number.isInteger(p) && Number.isSafeInteger(p)) {
      changed = true;
      return String(p);
    }
    if (typeof p === 'bigint') {
      changed = true;
      return p.toString();
    }
    return p;
  });
  return changed ? out : params;
}

/** Run a parameterised query. NEVER build SQL by concatenating user input. */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, coerceParams(params));
  return rows;
}

/** Same as query() but returns the first row or null. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE and return the raw ResultSetHeader. */
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, coerceParams(params));
  return result;
}

/**
 * Wrap a pooled connection so its .execute/.query get the same integer
 * coercion as the module-level helpers.
 *
 * Transactions call `conn.execute` directly (35 call sites), which would
 * otherwise walk straight around coerceParams and keep failing on MySQL 8.
 * The proxy forwards everything else untouched, so `beginTransaction`,
 * `commit`, `rollback` and `release` behave exactly as before.
 */
function wrapConnection(conn) {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === 'execute' || prop === 'query') {
        return (sql, params, ...rest) =>
          params === undefined
            ? target[prop](sql)
            : target[prop](sql, coerceParams(params), ...rest);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/**
 * Run a set of statements inside a transaction.
 * `fn` receives a dedicated connection with .query/.execute.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(wrapConnection(conn));
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      log.error('rollback failed', { error: rollbackErr.message });
    }
    throw err;
  } finally {
    conn.release();
  }
}

export async function assertDbConnection() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    const [[row]] = await conn.query('SELECT VERSION() AS version');
    log.info('connected', { database: env.DB.database, version: row.version });
  } finally {
    conn.release();
  }
}

export async function closePool() {
  await pool.end();
  log.info('pool closed');
}

export default pool;
