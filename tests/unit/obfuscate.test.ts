import { describe, expect, it } from "vitest";
import { pack, REAL_SLOTS, STAMP_SLOTS, unpack } from "../../src/identity/obfuscate.js";

const REALISTIC_TOKEN = Buffer.from(
  "a fake offline license token payload with realistic length and shape, padded past two hundred characters for chunking realism ".repeat(
    2,
  ),
).toString("base64");

const FIXED_SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

describe("obfuscate pack/unpack", () => {
  it("round-trips a realistic-length token", () => {
    const stamp = pack(REALISTIC_TOKEN, FIXED_SALT);
    expect(unpack(stamp.chunks, stamp.salt)).toBe(REALISTIC_TOKEN);
  });

  it("round-trips multibyte UTF-8 payloads", () => {
    const payload = "töken-with-ünïcode-and-emoji-🎉-padding";
    const stamp = pack(payload, FIXED_SALT);
    expect(unpack(stamp.chunks, stamp.salt)).toBe(payload);
  });

  it("emits STAMP_SLOTS chunks, real ones at REAL_SLOTS, every slot base64url", () => {
    const { chunks } = pack(REALISTIC_TOKEN, FIXED_SALT);
    expect(chunks).toHaveLength(STAMP_SLOTS);
    for (const chunk of chunks) expect(chunk).toMatch(/^[A-Za-z0-9_-]+$/);
    // Real chunks concatenate (decoded) to the XORed payload length.
    const realBytes = REAL_SLOTS.reduce(
      (n, slot) => n + Buffer.from(chunks[slot] ?? "", "base64url").length,
      0,
    );
    expect(realBytes).toBe(Buffer.byteLength(REALISTIC_TOKEN));
  });

  it("keeps raw token material out of every chunk (deterministic salt)", () => {
    const token = "a".repeat(200);
    const { chunks } = pack(token, FIXED_SALT);
    for (const chunk of chunks) expect(chunk).not.toMatch(/aaaa/i);
  });

  it("randomizes salt and decoys across packs of the same payload", () => {
    const a = pack(REALISTIC_TOKEN);
    const b = pack(REALISTIC_TOKEN);
    expect(a.salt).not.toBe(b.salt);
    const decoySlots = a.chunks.map((_, i) => i).filter((i) => !REAL_SLOTS.includes(i));
    expect(decoySlots.some((slot) => a.chunks[slot] !== b.chunks[slot])).toBe(true);
  });

  it("rejects payloads shorter than the chunk count", () => {
    expect(() => pack("short")).toThrow(/too short/);
  });

  it("does not recover the payload with a wrong salt", () => {
    const stamp = pack(REALISTIC_TOKEN, FIXED_SALT);
    const other = pack(REALISTIC_TOKEN);
    expect(unpack(stamp.chunks, other.salt)).not.toBe(REALISTIC_TOKEN);
  });

  it("rejects a corrupt stamp with the wrong chunk count", () => {
    expect(() => unpack(["only-one"], "c2FsdA")).toThrow(/corrupt stamp/);
  });
});
