/**
 * Token obfuscation for release builds (spec §Token obfuscation).
 *
 * This is NOT encryption: the salt ships next to the payload in the same
 * bundle, so anyone who reads the reassembly code can recover the token. The
 * goal is narrower — keep the raw offline license token out of grep-able
 * plaintext (`strings dist/cli.js`, `grep`, secret scanners) and pad it with
 * lookalike decoys.
 *
 * Layout: the XORed token is split into 7 chunks, base64url'd, and placed at
 * REAL_SLOTS within a 12-slot array; the remaining 5 slots hold random decoys
 * at fixed positions. Slots are fixed (not recorded in the stamp) so the
 * runtime reassembles without metadata.
 */

import { createHash, randomBytes } from "node:crypto";

/** Total slots in the stamped chunk array. */
export const STAMP_SLOTS = 12;
/** Fixed positions holding real chunks (7). All other slots are decoys (5). */
export const REAL_SLOTS: readonly number[] = [0, 2, 4, 6, 8, 10, 11];

function deriveKey(salt: Uint8Array): Uint8Array {
  return createHash("sha256").update(salt).digest();
}

function xorBytes(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] as number) ^ (key[i % key.length] as number);
  }
  return out;
}

function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function unb64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Split into exactly REAL_SLOTS.length near-equal, non-empty chunks. */
function split(data: Uint8Array): Uint8Array[] {
  const n = REAL_SLOTS.length;
  if (data.length < n) {
    throw new Error(`payload too short to stamp (${data.length} bytes, need >= ${n})`);
  }
  const base = Math.floor(data.length / n);
  const remainder = data.length % n;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const len = base + (i < remainder ? 1 : 0);
    chunks.push(data.subarray(offset, offset + len));
    offset += len;
  }
  return chunks;
}

export interface Stamp {
  /** base64url salt — deriveKey(salt) is the XOR key. */
  salt: string;
  /** STAMP_SLOTS base64url strings; real chunks at REAL_SLOTS, decoys elsewhere. */
  chunks: string[];
}

export function pack(payload: string, salt: Uint8Array = randomBytes(16)): Stamp {
  const cipher = xorBytes(new TextEncoder().encode(payload), deriveKey(salt));
  const parts = split(cipher).map(b64u);
  const chunks: string[] = new Array(STAMP_SLOTS);
  REAL_SLOTS.forEach((slot, i) => {
    chunks[slot] = parts[i] as string;
  });
  for (let slot = 0; slot < STAMP_SLOTS; slot++) {
    if (!REAL_SLOTS.includes(slot)) chunks[slot] = b64u(randomBytes(24));
  }
  return { salt: b64u(salt), chunks };
}

export function unpack(chunks: string[], saltB64: string): string {
  if (chunks.length !== STAMP_SLOTS) {
    throw new Error(`corrupt stamp: expected ${STAMP_SLOTS} chunks, got ${chunks.length}`);
  }
  const cipher = Buffer.concat(REAL_SLOTS.map((slot) => unb64u(chunks[slot] as string)));
  return new TextDecoder().decode(xorBytes(cipher, deriveKey(unb64u(saltB64))));
}
