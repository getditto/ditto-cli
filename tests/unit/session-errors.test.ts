import { describe, expect, it } from "vitest";
import {
  DataDirError,
  isLicenseError,
  LockError,
  PlatformError,
  TokenError,
} from "../../src/ditto/session.js";

describe("session error mapping", () => {
  it("isLicenseError matches license/token/verification failures", () => {
    expect(isLicenseError(new Error("The license failed verification"))).toBe(true);
    expect(isLicenseError(Object.assign(new Error("x"), { code: "auth/license-invalid" }))).toBe(
      true,
    );
    expect(isLicenseError(new Error("token expired"))).toBe(true);
  });

  it("isLicenseError does not swallow query errors mentioning nothing about licensing", () => {
    expect(isLicenseError(new Error("DQL parser error: Unexpected token"))).toBe(false);
    expect(isLicenseError(Object.assign(new Error("bad query"), { code: "query/invalid" }))).toBe(
      false,
    );
  });

  it("TokenError maps to exit 3, LockError to exit 4", () => {
    expect(new TokenError("x").exitCode).toBe(3);
    expect(new LockError("/dir").exitCode).toBe(4);
    expect(new LockError("/dir").message).toContain("/dir");
    expect(new PlatformError("no binding").exitCode).toBe(3);
    expect(new PlatformError("no binding").message).toContain("Supported:");
    expect(new DataDirError("/d", "EEXIST").exitCode).toBe(3);
    expect(new DataDirError("/d", "EEXIST").message).toContain("/d");
  });
});
