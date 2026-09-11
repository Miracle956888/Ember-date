/**
 * verify-fix.mjs — run this on YOUR machine, from the app folder:
 *
 *     node verify-fix.mjs
 *
 * It answers one question: is the running code actually the fixed code?
 * It does not touch your database and changes nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const poolPath = join(here, 'server', 'src', 'db', 'pool.js');

let ok = 0;
let bad = 0;
const pass = (m) => { ok++; console.log(`  OK   ${m}`); };
const fail = (m) => { bad++; console.log(`  FAIL ${m}`); };

console.log('\nChecking server/src/db/pool.js ...\n');

let src;
try {
  src = readFileSync(poolPath, 'utf8');
} catch {
  console.log(`  FAIL cannot read ${poolPath}`);
  console.log('\n  Run this from the folder that contains server\\src\\db\\pool.js\n');
  process.exit(1);
}

// 1. Is the fix even in the file?
if (src.includes('coerceParams')) pass('coerceParams() is present in the file');
else fail('coerceParams() is MISSING — this is still the old pool.js');

if (src.includes('wrapConnection')) pass('wrapConnection() is present (transaction coverage)');
else fail('wrapConnection() is MISSING — this is still the old pool.js');

// 2. Where does query() live? The old broken file had it around line 52.
const lines = src.split(/\r?\n/);
const queryLine = lines.findIndex((l) => l.includes('export async function query')) + 1;
console.log(`\n  query() is defined at line ${queryLine} (file is ${lines.length} lines)`);
if (queryLine > 80) {
  pass('query() sits well below line 80, as it does in the fixed file');
} else {
  fail(`query() at line ${queryLine} — the OLD file had it near line 52.`);
  console.log('       If your crash trace says pool.js:52, you are running the old file.');
}

// 3. Does query() actually apply the coercion?
const qBody = src.slice(src.indexOf('export async function query'), src.indexOf('export async function queryOne'));
if (qBody.includes('coerceParams(params)')) pass('query() applies coerceParams to its parameters');
else fail('query() does NOT apply coerceParams — the fix is not wired in');

// 4. Behaviour: integers must leave as strings, floats must stay numbers.
try {
  const mod = await import(pathToFileURL(poolPath).href);
  if (typeof mod.coerceParams === 'function') {
    const out = mod.coerceParams([20, 6.5244, null, 'x']);
    const good = out[0] === '20' && typeof out[1] === 'number' && out[2] === null && out[3] === 'x';
    if (good) pass(`coerceParams([20, 6.5244, null, 'x']) → ${JSON.stringify(out)}`);
    else fail(`coerceParams returned ${JSON.stringify(out)} — expected ["20", 6.5244, null, "x"]`);
  } else {
    fail('coerceParams is not exported');
  }
} catch (err) {
  fail(`could not import pool.js — ${err.message}`);
  console.log('       (a DB connection error here is fine; a syntax error is not)');
}

console.log(`\n${bad === 0 ? 'ALL GOOD — this is the fixed code.' : 'NOT FIXED — see the FAIL lines above.'}`);
console.log(`${ok} passed, ${bad} failed\n`);
if (bad === 0) console.log('If feeds still 500 after this passes, restart the server — Node caches the old file until you do.\n');
process.exit(bad === 0 ? 0 : 1);
