import { describe, expect, it } from "vitest";
import { daysUntilExpiry, IdentityError, loadIdentity } from "../../src/identity/token.js";

describe("loadIdentity (dev build)", () => {
  it("reads DATABASE_ID + OFFLINE_TOKEN", () => {
    const id = loadIdentity({
      DATABASE_ID: "app-1",
      OFFLINE_TOKEN: "tok-1",
      EXPIRE_ON: "2027-01-01",
    } as NodeJS.ProcessEnv);
    expect(id).toEqual({ appId: "app-1", token: "tok-1", expiresOn: "2027-01-01", source: "env" });
  });

  it("falls back to DITTO_APP_ID + DQL_OFFLINE_LICENSE aliases", () => {
    const id = loadIdentity({
      DITTO_APP_ID: "app-2",
      DQL_OFFLINE_LICENSE: "tok-2",
    } as NodeJS.ProcessEnv);
    expect(id.appId).toBe("app-2");
    expect(id.token).toBe("tok-2");
    expect(id.expiresOn).toBeUndefined();
  });

  it("primary names win over aliases", () => {
    const id = loadIdentity({
      DATABASE_ID: "primary",
      DITTO_APP_ID: "alias",
      OFFLINE_TOKEN: "primary-tok",
      DQL_OFFLINE_LICENSE: "alias-tok",
    } as NodeJS.ProcessEnv);
    expect(id.appId).toBe("primary");
    expect(id.token).toBe("primary-tok");
  });

  it("throws IdentityError (exit 3) when credentials are missing", () => {
    expect(() => loadIdentity({} as NodeJS.ProcessEnv)).toThrow(IdentityError);
    try {
      loadIdentity({} as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as IdentityError).exitCode).toBe(3);
      expect((err as IdentityError).message).toContain(".env");
    }
  });

  it("throws when only one of the pair is set", () => {
    expect(() => loadIdentity({ DATABASE_ID: "x" } as NodeJS.ProcessEnv)).toThrow(IdentityError);
    expect(() => loadIdentity({ OFFLINE_TOKEN: "x" } as NodeJS.ProcessEnv)).toThrow(IdentityError);
  });
});

describe("daysUntilExpiry", () => {
  const now = new Date("2026-08-29T00:00:00Z");

  it("is null when unset or unparseable", () => {
    expect(daysUntilExpiry(undefined, now)).toBeNull();
    expect(daysUntilExpiry("not-a-date", now)).toBeNull();
  });

  it("is positive for future dates, negative for past", () => {
    expect(daysUntilExpiry("2026-09-28T00:00:00Z", now)).toBe(30);
    expect(daysUntilExpiry("2026-08-19T00:00:00Z", now)).toBe(-10);
    expect(daysUntilExpiry("2026-08-29T12:00:00Z", now)).toBe(0);
  });
});
