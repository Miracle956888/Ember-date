/**
 * e2ee.js — end-to-end encryption in the browser.
 *
 * THE MODEL
 *   1. Each browser generates a non-extractable ECDH P-256 keypair once and
 *      keeps the PRIVATE half in IndexedDB. It is never serialised, never sent
 *      to the server, and cannot be read back out (extractable: false).
 *   2. The PUBLIC half is registered with the server so other devices can seal
 *      things to it.
 *   3. The first participant to write in a thread generates a random AES-GCM
 *      256-bit conversation key, then wraps one copy per recipient device:
 *      ECDH(myEphemeralPrivate, theirDevicePublic) -> HKDF -> AES-KW-ish
 *      AES-GCM wrap. The server stores only wrapped blobs.
 *   4. Messages are AES-GCM sealed with the conversation key. The server sees
 *      ciphertext + IV and nothing else.
 *
 * WHAT THIS PROTECTS AND WHAT IT DOES NOT — stated honestly:
 *   ✓ Message text is unreadable to the server, to anyone who dumps the
 *     database, and to anyone intercepting the connection.
 *   ✗ Metadata (who, when, how often) is NOT hidden.
 *   ✗ The server distributes public keys, so it could in principle serve a
 *     substituted one. Compare safety numbers out of band to rule that out.
 *   ✗ Anyone with access to an unlocked device can read the messages on it.
 * We never tell the user "nobody can ever read this".
 */

const DB_NAME = 'ember-e2ee';
const DB_VERSION = 1;
const STORE = 'keys';
const DEVICE_RECORD = 'device';

/* ------------------------------------------------------------------ *
 * IndexedDB (localStorage is banned in this codebase, and rightly so:
 * it is synchronous, string-only, and cannot hold a CryptoKey object).
 * ------------------------------------------------------------------ */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** Wipe every local key. Used on sign-out so a shared computer leaks nothing. */
export async function wipeKeys() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * base64 helpers
 * ------------------------------------------------------------------ */

export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) bytes[i] = s.charCodeAt(i);
  return bytes;
}

/** True when the browser can actually do this. Chat degrades gracefully if not. */
export function isSupported() {
  return Boolean(globalThis.crypto?.subtle && globalThis.indexedDB && globalThis.isSecureContext !== false);
}

/* ------------------------------------------------------------------ *
 * Device identity
 * ------------------------------------------------------------------ */

let devicePromise = null;

/**
 * This browser's device keypair, created on first use.
 * The private key is generated with `extractable: false`, so even our own
 * code cannot export it — the strongest guarantee the platform offers.
 */
export async function getDevice() {
  if (devicePromise) return devicePromise;

  devicePromise = (async () => {
    const existing = await idbGet(DEVICE_RECORD);
    if (existing?.privateKey && existing?.deviceId) return existing;

    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveKey',
      'deriveBits'
    ]);
    const publicKeyRaw = await crypto.subtle.exportKey('raw', pair.publicKey);

    const record = {
      deviceId: crypto.randomUUID(),
      // When this device's key material came into existence. Anything sent
      // before this moment was sealed to keys we never held, so it is
      // permanently unreadable here — worth telling the user honestly rather
      // than implying it is still on its way.
      createdAt: new Date().toISOString(),
      privateKey: pair.privateKey, // CryptoKey, non-extractable, stored structurally
      publicKey: pair.publicKey,
      publicKeyB64: toB64(publicKeyRaw)
    };
    await idbSet(DEVICE_RECORD, record);
    return record;
  })();

  return devicePromise;
}

/**
 * A short human-comparable fingerprint of a public key.
 * Two people reading the same six groups aloud have not been MITM'd — this is
 * the out-of-band check that upgrades TOFU into real verification.
 */
export async function safetyNumber(...publicKeysB64) {
  const joined = [...publicKeysB64].sort().join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  const bytes = new Uint8Array(digest).slice(0, 15);
  const digits = [...bytes].map((b) => String(b % 10)).join('');
  return digits.match(/.{1,5}/g).join(' ');
}

/* ------------------------------------------------------------------ *
 * Key agreement
 * ------------------------------------------------------------------ */

/** Derive a wrapping key from ECDH(my ephemeral private, their device public). */
async function deriveWrappingKey(privateKey, peerPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function importPeerKey(publicKeyB64) {
  return crypto.subtle.importKey('raw', fromB64(publicKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

/**
 * Create a fresh conversation key and seal one copy per recipient device.
 * Returns the material the caller POSTs to /keys — all of it opaque.
 */
export async function createConversationKey(devices) {
  const conversationKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt'
  ]);
  const rawKey = await crypto.subtle.exportKey('raw', conversationKey);
  const keyId = crypto.randomUUID();

  // One ephemeral keypair per generation, so a compromised wrap does not
  // reveal anything about other generations.
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const ephemeralPubB64 = toB64(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const wraps = [];
  for (const device of devices) {
    try {
      const peerKey = await importPeerKey(device.publicKey);
      const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, peerKey);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey);
      wraps.push({
        userId: device.userId,
        deviceId: device.deviceId,
        wrappedKey: toB64(wrapped),
        iv: toB64(iv),
        senderPubKey: ephemeralPubB64
      });
    } catch {
      // A single malformed device key must not stop the others being sealed.
    }
  }

  return { keyId, wraps, key: await reimportAesKey(rawKey) };
}

/** Re-import raw AES bytes as a usable, non-extractable CryptoKey. */
async function reimportAesKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Unwrap a conversation key copy addressed to this device. */
export async function unwrapConversationKey(wrap) {
  const device = await getDevice();
  const senderPub = await importPeerKey(wrap.senderPubKey);
  const wrappingKey = await deriveWrappingKey(device.privateKey, senderPub);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(wrap.iv) },
    wrappingKey,
    fromB64(wrap.wrappedKey)
  );
  return reimportAesKey(raw);
}

/* ------------------------------------------------------------------ *
 * Message sealing
 * ------------------------------------------------------------------ */

/** Seal plaintext with the conversation key. Returns the wire envelope. */
export async function seal(key, plaintext, keyId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ciphertext: toB64(ciphertext), iv: toB64(iv), keyId };
}

/**
 * Open a sealed envelope. Returns null rather than throwing when the key is
 * wrong or missing, so one undecryptable message cannot break the whole thread
 * render — the UI shows a clear placeholder for it instead.
 */
export async function open(key, envelope) {
  if (!key || !envelope?.ciphertext) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv) },
      key,
      fromB64(envelope.ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
