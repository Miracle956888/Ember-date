import { env } from '../config/env.js';

/**
 * Shared mysql2 connection settings for both the web pool and migration runner.
 * Keeping TLS, host, credentials, and port in one place prevents startup and
 * migrations from drifting onto different database transports.
 */
export function mysqlConnectionOptions({ includeDatabase = true } = {}) {
  return {
    host: env.DB.host,
    port: env.DB.port,
    user: env.DB.user,
    password: env.DB.password,
    ...(includeDatabase ? { database: env.DB.database } : {}),
    socketPath: env.DB.socketPath,
    ssl: env.DB.ssl
  };
}
