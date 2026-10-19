import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAGE_NAMES, isPublicHandleRouteCandidate } from '../../server/src/config/pages.js';
import { publicProfilePath, safeReturnPath } from '../../public/js/navigation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(root, 'public');
const htmlFiles = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html')).sort();

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2]) : null;
}

test('every HTML shell is registered or is the custom 404 fallback', () => {
  const expected = [...PAGE_NAMES.map((name) => `${name}.html`), '404.html'].sort();
  assert.deepEqual(htmlFiles, expected);
  for (const name of PAGE_NAMES) {
    assert.ok(fs.existsSync(path.join(publicDir, `${name}.html`)), `missing page shell: ${name}.html`);
  }
});

test('all pages have a title, mobile viewport, main landmark, unique IDs and image alt text', () => {
  for (const filename of htmlFiles) {
    const html = fs.readFileSync(path.join(publicDir, filename), 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/i, `${filename} needs a document title`);
    assert.match(html, /<meta\s+name="viewport"/i, `${filename} needs a mobile viewport`);
    assert.match(html, /<main\b/i, `${filename} needs a main landmark`);

    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${filename} has duplicate element IDs`);
    for (const image of html.matchAll(/<img\b[^>]*>/gi)) {
      assert.notEqual(attribute(image[0], 'alt'), null, `${filename} has an image without an alt attribute`);
    }
  }
});

test('all local page assets and JavaScript imports resolve inside the public tree', () => {
  for (const filename of htmlFiles) {
    const html = fs.readFileSync(path.join(publicDir, filename), 'utf8');
    for (const tag of html.matchAll(/<(?:script|img|source|video|audio|link|iframe)\b[^>]*>/gi)) {
      const raw = attribute(tag[0], 'src') || attribute(tag[0], 'href') || attribute(tag[0], 'poster');
      if (!raw || /^(?:https?:|data:|blob:|mailto:|tel:)/i.test(raw) || raw.startsWith('//')) continue;
      const pathname = new URL(raw, 'https://ember.invalid/').pathname;
      const localFile = path.resolve(publicDir, `.${pathname}`);
      assert.ok(localFile.startsWith(`${publicDir}${path.sep}`), `${filename} asset escapes public/: ${raw}`);
      assert.ok(fs.existsSync(localFile), `${filename} references a missing asset: ${raw}`);
    }
  }

  const modules = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.name.endsWith('.js')) modules.push(candidate);
    }
  };
  walk(path.join(publicDir, 'js'));
  for (const filename of modules) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const resolved = specifier.startsWith('/')
        ? path.join(publicDir, specifier.slice(1))
        : path.resolve(path.dirname(filename), specifier);
      assert.ok(fs.existsSync(resolved), `${path.relative(publicDir, filename)} imports missing ${specifier}`);
    }
  }
});

test('every static local anchor resolves to a routed page, asset, or valid share handle', () => {
  const pageRoutes = new Set(PAGE_NAMES.flatMap((name) => [name === 'index' ? '/' : `/${name}`, `/${name}.html`]));
  for (const filename of htmlFiles) {
    const html = fs.readFileSync(path.join(publicDir, filename), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

    for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
      const raw = attribute(match[0], 'href');
      if (raw === null) continue;
      const href = raw.replace(/&amp;/g, '&').trim();
      assert.notEqual(href, '#', `${filename} contains an inert placeholder link`);
      if (!href || /^(?:https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('//')) continue;
      if (href.startsWith('#')) {
        assert.ok(ids.has(decodeURIComponent(href.slice(1))), `${filename} has a broken fragment link: ${href}`);
        continue;
      }
      if (!href.startsWith('/')) continue;

      const route = href.split(/[?#]/, 1)[0];
      if (route.startsWith('/@')) {
        assert.ok(isPublicHandleRouteCandidate(decodeURIComponent(route.slice(2))), `${filename} has an invalid profile link: ${href}`);
        continue;
      }
      if (pageRoutes.has(route)) continue;
      const localFile = path.resolve(publicDir, `.${route}`);
      assert.ok(localFile.startsWith(`${publicDir}${path.sep}`), `${filename} link escapes the public directory: ${href}`);
      assert.ok(fs.existsSync(localFile), `${filename} links to a missing local page or asset: ${href}`);
    }
  }
});

test('person cards use shareable profile URLs and both profile routing layers allow 30-character handles', () => {
  assert.equal(publicProfilePath('amara', 'search'), '/@amara?from=search');
  assert.equal(publicProfilePath('a'.repeat(30)), `/@${'a'.repeat(30)}`);
  assert.throws(() => publicProfilePath('a'.repeat(31)), /invalid username/i);
  assert.equal(isPublicHandleRouteCandidate('a'.repeat(30)), true);
  assert.equal(isPublicHandleRouteCandidate('a'.repeat(31)), false);

  const people = fs.readFileSync(path.join(publicDir, 'js/people.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');
  assert.match(people, /publicProfilePath\(person\.username, source\)/);
  assert.doesNotMatch(people, /\/profile\?id=/);
  assert.match(server, /isPublicHandleRouteCandidate\(req\.params\.username\)/);
});

test('signed-out share profiles can load active photos without bypassing signed-in block checks', () => {
  const server = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'server/src/controllers/user.controller.js'), 'utf8');
  const uploads = fs.readFileSync(path.join(root, 'server/src/services/upload.service.js'), 'utf8');
  const photoLookup = uploads.slice(uploads.indexOf('export async function getPhotoForViewer('), uploads.indexOf('\nexport async function deleteAttachmentsByIds'));

  assert.match(server, /app\.get\('\/api\/photos\/:filename', optionalAuth, servePhoto\)/);
  assert.match(controller, /getPhotoForViewer\(req\.params\.filename, req\.user\?\.id \?\? null\)/);
  assert.match(photoLookup, /pu\.status = 'active'/);
  assert.match(photoLookup, /u\.status = 'active'/);
  assert.match(photoLookup, /viewer !== null && ownerId !== viewer/);
});

test('workflow-only shells have real app entry points even without static menu anchors', () => {
  const email = fs.readFileSync(path.join(root, 'server/src/services/email.service.js'), 'utf8');
  const matches = fs.readFileSync(path.join(publicDir, 'js/match-rows.js'), 'utf8');
  const calls = fs.readFileSync(path.join(publicDir, 'js/call.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');

  assert.match(email, /new URL\('\/reset-password'/, 'password reset is entered from its email link');
  assert.match(matches, /href="\/chat\?c=/, 'chat is entered from match rows');
  assert.match(calls, /location\.href = `\/call\?/, 'calls navigate to the call shell');
  assert.match(server, /app\.get\('\/@:username'/, 'shareable handles render the public profile shell');
  assert.ok(PAGE_NAMES.includes('u'), 'the profile shell remains part of the canonical page list');
});

test('login return paths reject protocol-relative and external destinations', () => {
  assert.equal(safeReturnPath('/chat?c=42'), '/chat?c=42');
  assert.equal(safeReturnPath('/@amara'), '/@amara');
  assert.equal(safeReturnPath('//example.com/phish'), '/app');
  assert.equal(safeReturnPath('/\\\\example.com/phish'), '/app');
  assert.equal(safeReturnPath('https://example.com/phish'), '/app');
  assert.equal(safeReturnPath('javascript:alert(1)'), '/app');
});
