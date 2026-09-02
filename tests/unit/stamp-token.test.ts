import { describe, expect, it } from "vitest";
import {
  checkExpiryWindow,
  extractExpiry,
  MIN_EXPIRY_DAYS,
  renderStampModule,
  WARN_EXPIRY_DAYS,
} from "../../scripts/stamp-token.js";
import { pack, unpack } from "../../src/identity/obfuscate.js";

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

// Mimics the real Ditto offline token shape: base64 of a CBOR-ish map holding
// `expiry` + an ISO datetime (as found in the dev token from .env).
const CBORISH_TOKEN = Buffer.from(
  "£guser_idlDev Advocacyfexpiryx\u00182027-05-01T04:59:59.999Zisignature-stuff",
  "latin1",
).toString("base64");

describe("extractExpiry", () => {
  it("reads exp from a JWT payload", () => {
    expect(extractExpiry(fakeJwt({ exp: 1_893_456_000 }))).toBe("2030-01-01");
  });

  it("reads the ISO datetime after `expiry` in a CBOR-ish token", () => {
    expect(extractExpiry(CBORISH_TOKEN)).toBe("2027-05-01");
  });

  it("returns null when no expiry is detectable", () => {
    expect(extractExpiry("not-a-token")).toBeNull();
    expect(extractExpiry(fakeJwt({ sub: "x" }))).toBeNull();
  });
});

describe("checkExpiryWindow", () => {
  it("throws under MIN_EXPIRY_DAYS, including already-expired", () => {
    expect(() => checkExpiryWindow(MIN_EXPIRY_DAYS - 1)).toThrow(/before stamping/);
    expect(() => checkExpiryWindow(-30)).toThrow(/expired 30 days ago/);
  });

  it("warns between MIN and WARN, ok above", () => {
    expect(checkExpiryWindow(MIN_EXPIRY_DAYS)).toBe("warn");
    expect(checkExpiryWindow(WARN_EXPIRY_DAYS - 1)).toBe("warn");
    expect(checkExpiryWindow(WARN_EXPIRY_DAYS)).toBe("ok");
    expect(checkExpiryWindow(400)).toBe("ok");
  });
});

describe("renderStampModule", () => {
  it("emits a stamped module that round-trips and hides the raw token", () => {
    const stamp = pack("the-secret-token-value");
    const mod = renderStampModule("app-1", "2027-05-01", stamp);
    expect(mod).toContain("STAMPED = true");
    expect(mod).toContain('"app-1"');
    expect(mod).toContain('"2027-05-01"');
    expect(mod).not.toContain("the-secret-token-value");
    // The rendered module's data must reassemble the original payload.
    expect(unpack(stamp.chunks, stamp.salt)).toBe("the-secret-token-value");
  });
});
