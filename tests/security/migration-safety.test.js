import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV ||= 'test';
process.env.APP_ORIGIN ||= 'http://localhost:3000';
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_PORT ||= '3306';
process.env.DB_USER ||= 'security-test';
process.env.DB_PASSWORD ||= 'security-test-only';
process.env.DB_NAME ||= 'never_connected_security_test';
process.env.JWT_ACCESS_SECRET ||= 'security-unit-access-secret-with-32-bytes';
process.env.JWT_REFRESH_SECRET ||= 'security-unit-refresh-secret-with-32-bytes';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  baselineTableColumns,
  decideMigration,
  loadMigrations,
  splitStatements,
  validateContiguousHistory
} = await import('../../db/migrate.js');

const migrations = await loadMigrations(path.join(root, 'db', 'migrations'));

test('baseline and additive migrations are ordered and checksummed', () => {
  assert.equal(migrations[0].filename, '0001_baseline.sql');
  assert.deepEqual(migrations.map(({ version }) => version), ['0001', '0002', '0003']);
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.ok(migration.statements.length > 0);
  }
});

test('baseline parser accounts for the complete initial schema', async () => {
  const baseline = await fs.readFile(path.join(root, 'db/migrations/0001_baseline.sql'), 'utf8');
  const documented = await fs.readFile(path.join(root, 'db/schema.sql'), 'utf8');
  const shape = baselineTableColumns(baseline);
  assert.equal(shape.size, 42);
  assert.equal([...shape.values()].reduce((count, columns) => count + columns.length, 0), 330);
  assert.equal(documented, baseline);
  assert.equal(splitStatements(baseline).length, 43);
});

test('legacy schema decisions never replay baseline DDL over an unverified database', () => {
  assert.equal(decideMigration({}).action, 'apply');
  assert.equal(decideMigration({ existingTables: 42 }).action, 'refuse');
  assert.equal(decideMigration({ existingTables: 42, legacyBaselineValid: true }).action, 'adopt');
  assert.equal(decideMigration({ existingTables: 1, legacyBaselineValid: false }).action, 'refuse');
});

test('migration history must be contiguous and is checked in order', () => {
  assert.equal(validateContiguousHistory(migrations, ['0001']), 0);
  assert.equal(validateContiguousHistory(migrations, ['0001', '0002']), 1);
  assert.equal(validateContiguousHistory(migrations, ['0001', '0002', '0003']), 2);
  assert.throws(
    () => validateContiguousHistory(migrations, ['0002']),
    /Migration history has a gap/,
    'a recorded later migration must not mask a missing baseline'
  );
  assert.equal(validateContiguousHistory(migrations, []), -1);
});

test('normal migrations preserve data and defer reviewed-evidence deletion to the durable queue', () => {
  const allSql = migrations.map((migration) => migration.sql).join('\n');
  assert.doesNotMatch(allSql, /\b(?:DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE)\b/i);
  const security = migrations.find((migration) => migration.version === '0002').sql;
  const queuedAt = security.indexOf("INSERT IGNORE INTO media_deletion_queue (file_key, reason)");
  const clearedAt = security.indexOf('UPDATE verifications\n   SET file_path = NULL');
  assert.ok(queuedAt >= 0 && clearedAt > queuedAt, 'the storage key is queued before the DB reference is cleared');
  assert.match(security, /UPDATE users u[\s\S]*?SET u\.is_verified = 0/);
  const sendHistory = migrations.find((migration) => migration.version === '0003').sql;
  assert.match(sendHistory, /ADD COLUMN revoked_at DATETIME NULL/);
  assert.match(sendHistory, /idx_vtoken_active/);
});
