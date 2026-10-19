import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const source = (filename) => fs.readFileSync(path.join(root, filename), 'utf8');
const { MEDIA_DELETE_REASON, normalizeMediaKeys } = await import('../../server/src/services/media-deletion.service.js');
const { socialMediaSchema } = await import('../../server/src/utils/validators.js');

function section(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  const to = end ? text.indexOf(end, from + start.length) : text.length;
  assert.notEqual(to, -1, `missing ending source marker: ${end}`);
  return text.slice(from, to < 0 ? text.length : to);
}

test('media deletion keys are de-duplicated and confined to safe relative paths', () => {
  assert.deepEqual(
    normalizeMediaKeys(['photos/a.jpg', 'thumbs/a.webp', 'photos/a.jpg', null, '']),
    ['photos/a.jpg', 'thumbs/a.webp']
  );
  assert.deepEqual(normalizeMediaKeys('videos/clip.mp4'), ['videos/clip.mp4']);
  for (const unsafe of [
    '../secret.jpg',
    'photos/../secret.jpg',
    '/etc/passwd',
    'photos\\secret.jpg',
    'photos//secret.jpg',
    'photos/file with spaces.jpg'
  ]) {
    assert.throws(() => normalizeMediaKeys(unsafe), /unsafe media storage key/i, unsafe);
  }
  assert.deepEqual(Object.values(MEDIA_DELETE_REASON), [
    'account_deleted', 'verification_reviewed', 'content_removed', 'profile_photo_removed', 'orphaned_upload'
  ]);
});

test('social upload API accepts an owner-bound UUID handle, never client-provided storage keys', () => {
  const handle = 'b67e40bc-1bca-4b77-9d0e-7f798a9cbe37';
  assert.equal(socialMediaSchema.safeParse({ uploadId: handle }).success, true);
  assert.equal(socialMediaSchema.safeParse({ fileKey: 'photos/secret.jpg', url: '/api/social-media/secret' }).success, false);

  const uploads = source('server/src/services/upload.service.js');
  const social = section(uploads, 'export async function processSocialUpload(', '\nexport async function');
  assert.match(social, /INSERT INTO pending_social_uploads/);
  assert.match(social, /DATE_ADD\(NOW\(\), INTERVAL 2 HOUR\)/);
  assert.match(social, /return \{[\s\S]*?uploadId,[\s\S]*?kind,[\s\S]*?url,[\s\S]*?thumbUrl/);
  assert.doesNotMatch(social.slice(social.indexOf('return {')), /fileKey|thumbKey/);

  const posts = source('server/src/services/post.service.js');
  const createPost = section(posts, 'export async function createPost(', '\nexport async function getPost');
  assert.match(createPost, /WHERE owner_id = \? AND expires_at > NOW\(\) AND upload_id IN/);
  assert.match(createPost, /DELETE FROM pending_social_uploads/);
  assert.match(createPost, /upload\.media_url/);

  const moments = source('server/src/services/moment.service.js');
  const createMoment = section(moments, 'export async function createMoment(', '\nexport async function getMoment');
  assert.match(createMoment, /WHERE upload_id = \? AND owner_id = \? AND expires_at > NOW\(\)/);
  assert.match(createMoment, /DELETE FROM pending_social_uploads/);
});

test('media ownership changes enqueue file keys before deleting or cascading their DB rows', () => {
  const checks = [
    ['server/src/services/user.service.js', 'async function enqueueMatchMedia(', "await conn.execute('DELETE FROM matches"],
    ['server/src/services/match.service.js', 'export async function unmatch(', "await conn.execute('DELETE FROM matches"],
    ['server/src/services/swipe.service.js', 'export async function rewindLastSwipe(', "await conn.execute('DELETE FROM matches"],
    ['server/src/services/message.service.js', 'export async function clearConversation(', "await conn.execute(\n      `UPDATE attachments"],
    ['server/src/services/moment.service.js', 'export async function deleteMoment(', "await conn.execute('UPDATE moments SET deleted_at"],
    ['server/src/services/post.service.js', 'export async function deletePost(', "await conn.execute('UPDATE posts SET deleted_at"],
    ['server/src/services/auth.service.js', 'export async function deleteAccount(', "const [result] = await conn.execute('DELETE FROM users"]
  ];

  for (const [filename, start, destructive] of checks) {
    const text = source(filename);
    const body = section(text, start, destructive);
    assert.match(body, /enqueueMediaDeletion/, `${filename} must queue media before the destructive write`);
  }

  const user = source('server/src/services/user.service.js');
  const photoDelete = section(user, 'export async function deletePhoto(', '\nexport async function reorderPhotos');
  assert.ok(photoDelete.indexOf('enqueueMediaDeletion') < photoDelete.indexOf('DELETE FROM user_photos'));

  const cleanup = source('server/src/jobs/cleanup.js');
  assert.match(cleanup, /NOT EXISTS \(SELECT 1 FROM attachments a WHERE a\.message_id = msg\.id\)/);
  assert.doesNotMatch(cleanup, /storage\.remove\(/);
});

test('all ordinary unlink attempts use the retryable outbox; raw unlink is only a DB-down fallback', () => {
  const serviceFiles = [
    'server/src/services/match.service.js',
    'server/src/services/message.service.js',
    'server/src/services/moment.service.js',
    'server/src/services/post.service.js',
    'server/src/services/user.service.js',
    'server/src/services/swipe.service.js',
    'server/src/jobs/cleanup.js'
  ];
  for (const filename of serviceFiles) assert.doesNotMatch(source(filename), /storage\.remove\(/, filename);

  const uploads = source('server/src/services/upload.service.js');
  assert.equal((uploads.match(/storage\.remove\(/g) || []).length, 1);
  assert.match(uploads, /unowned media cleanup could not be made durable/);

  const worker = source('server/src/services/media-deletion.service.js');
  assert.match(worker, /processMediaDeletionQueue/);
  assert.match(worker, /attempts = attempts \+ 1/);
  assert.match(worker, /await storage\.remove\(key\)/);
});
