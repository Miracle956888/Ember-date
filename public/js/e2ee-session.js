/**
 * e2ee-session.js — per-conversation encryption session.
 *
 * Bridges the raw crypto in e2ee.js to the API:
 *   - registers this browser's device key once per sign-in;
 *   - fetches or creates the conversation key;
 *   - seals outgoing messages and opens incoming ones;
 *   - republishes the key when a new device joins, so nobody gets locked out.
 *
 * Every method degrades gracefully. If the browser lacks WebCrypto, or key
 * setup fails, `ready` stays false and chat falls back to plaintext transport
 * with the UI clearly saying encryption is unavailable — a silent downgrade
 * that still *claimed* to be encrypted would be the worst possible outcome.
 */
import { api } from './api.js';
import * as e2ee from './e2ee.js';

let devicePromise = null;

/** Register this browser's public key. Idempotent; safe to call repeatedly. */
export async function ensureDeviceRegistered() {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    const device = await e2ee.getDevice();
    await api.registerDevice({
      deviceId: device.deviceId,
      publicKey: device.publicKeyB64,
      algorithm: 'ECDH-P256'
    });
    return device;
  })();
  return devicePromise;
}

export class ConversationCrypto {
  constructor(conversationId) {
    this.conversationId = conversationId;
    this.keys = new Map(); // keyId -> CryptoKey
    this.activeKeyId = null;
    this.ready = false;
    this.reason = null;
    /** When this device's keys were created; older messages cannot be read. */
    this.deviceCreatedAt = null;
    this.safetyNumber = null;
  }

  /** True when we can actually seal a message right now. */
  get canEncrypt() {
    return this.ready && Boolean(this.activeKeyId && this.keys.get(this.activeKeyId));
  }

  /**
   * Bring the session up: register the device, unwrap every key copy addressed
   * to us, and publish a new generation if any active device lacks one.
   */
  async init() {
    if (!e2ee.isSupported()) {
      this.reason = 'This browser does not support encrypted messaging.';
      return this;
    }

    try {
      const device = await ensureDeviceRegistered();
      this.deviceCreatedAt = device.createdAt ? Date.parse(device.createdAt) : null;

      // 1. Unwrap whatever this device can already read.
      const { keys } = await api.myKeys(this.conversationId, device.deviceId);
      for (const wrap of keys) {
        const key = await e2ee.unwrapConversationKey(wrap).catch(() => null);
        if (key) {
          this.keys.set(wrap.keyId, key);
          if (!this.activeKeyId) this.activeKeyId = wrap.keyId;
        }
      }

      // 2. Is every active device covered by the newest generation? A new
      //    phone, or a peer who cleared storage, means someone would be
      //    unable to read what we send next.
      const coverage = await api.keyCoverage(this.conversationId);
      const needNewKey = !coverage.covered || !this.canEncrypt;

      if (needNewKey) {
        const { devices } = await api.conversationDevices(this.conversationId);
        if (devices.length) {
          const created = await e2ee.createConversationKey(devices);
          if (created.wraps.length) {
            await api.publishKeys(this.conversationId, { keyId: created.keyId, wraps: created.wraps });
            this.keys.set(created.keyId, created.key);
            this.activeKeyId = created.keyId;
          }
        }
      }

      // 3. Safety number, so the two people can verify out of band.
      const { devices } = await api.conversationDevices(this.conversationId);
      if (devices.length) {
        this.safetyNumber = await e2ee.safetyNumber(...devices.map((d) => d.publicKey));
      }

      this.ready = this.keys.size > 0;
      if (!this.ready) this.reason = 'Waiting for the other person to open the chat.';
    } catch (err) {
      this.ready = false;
      this.reason = 'Encryption could not be set up on this device.';
      console.warn('[e2ee] session init failed', err?.message || err);
    }

    return this;
  }

  /** A peer published a new generation; pick it up without a reload. */
  async refreshKeys() {
    try {
      const device = await e2ee.getDevice();
      const { keys } = await api.myKeys(this.conversationId, device.deviceId);
      for (const wrap of keys) {
        if (this.keys.has(wrap.keyId)) continue;
        const key = await e2ee.unwrapConversationKey(wrap).catch(() => null);
        if (key) {
          this.keys.set(wrap.keyId, key);
          this.activeKeyId = wrap.keyId;
          this.ready = true;
          this.reason = null;
        }
      }
    } catch {
      // Non-fatal: we keep whatever keys we already hold.
    }
    return this.ready;
  }

  /** Seal outgoing text. Returns null when encryption is unavailable. */
  async seal(plaintext) {
    if (!this.canEncrypt) return null;
    try {
      return await e2ee.seal(this.keys.get(this.activeKeyId), plaintext, this.activeKeyId);
    } catch {
      return null;
    }
  }

  /**
   * Open an incoming envelope, trying the generation it names first and then
   * every other key we hold (a message may predate our newest key).
   */
  async open(envelope) {
    if (!envelope?.ciphertext) return null;

    const named = envelope.keyId && this.keys.get(envelope.keyId);
    if (named) {
      const text = await e2ee.open(named, envelope);
      if (text !== null) return text;
    }
    for (const key of this.keys.values()) {
      const text = await e2ee.open(key, envelope);
      if (text !== null) return text;
    }

    // Try once more after refetching: the sender may have just published a key.
    if (await this.refreshKeys()) {
      for (const key of this.keys.values()) {
        const text = await e2ee.open(key, envelope);
        if (text !== null) return text;
      }
    }
    return null;
  }
}

export { wipeKeys } from './e2ee.js';
