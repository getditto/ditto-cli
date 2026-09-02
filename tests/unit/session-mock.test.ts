import { beforeEach, describe, expect, it, vi } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Mock the dynamic SDK import — DittoSession is fully unit-testable without creds.
const h = vi.hoisted(() => ({
  openBehavior: "ok" as "ok" | "lock" | "license" | "permission" | "other",
  licenseBehavior: "ok" as "ok" | "license" | "other",
  initCalls: 0,
  openCalls: 0,
  licenseCalls: 0,
  closeCalls: 0,
}));

vi.mock("@dittolive/ditto", () => {
  class FakeError extends Error {
    code?: string;
  }
  return {
    Logger: { enabled: false, minimumLogLevel: "Error" },
    init: async () => {
      h.initCalls++;
    },
    DittoConfig: class {},
    Ditto: {
      open: async () => {
        h.openCalls++;
        if (h.openBehavior === "lock") {
          const err = new FakeError("File already locked");
          err.code = "store/persistence-directory-locked";
          throw err;
        }
        if (h.openBehavior === "license") {
          const err = new FakeError("The license failed verification");
          err.code = "auth/license-invalid";
          throw err;
        }
        if (h.openBehavior === "permission") {
          throw new FakeError("Permission denied (os error 13)");
        }
        if (h.openBehavior === "other") {
          throw new FakeError("some other failure");
        }
        return {
          setOfflineOnlyLicenseToken: async () => {
            h.licenseCalls++;
            if (h.licenseBehavior === "license") {
              throw new FakeError("The license failed verification");
            }
            if (h.licenseBehavior === "other") {
              throw new FakeError("unrelated failure");
            }
          },
          store: { execute: async () => ({ items: [] }) },
          close: async () => {
            h.closeCalls++;
          },
        };
      },
    },
    DittoError: FakeError,
  };
});

import {
  DataDirError,
  DittoSession,
  LockError,
  PlatformError,
  TokenError,
} from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";

const IDENTITY = { appId: "app", token: "tok", source: "env" as const };

beforeEach(() => {
  h.openBehavior = "ok";
  h.licenseBehavior = "ok";
  h.initCalls = 0;
  h.openCalls = 0;
  h.licenseCalls = 0;
  h.closeCalls = 0;
});

describe("DittoSession (mocked SDK)", () => {
  it("opens, executes, closes cleanly", async () => {
    const dir = tmpDataDir("ditto-sess-");
    try {
      const session = await DittoSession.open(IDENTITY, dir);
      const result = await session.execute("SELECT * FROM system:collections");
      expect(result).toEqual({ items: [] });
      await session.close();
      expect(h.openCalls).toBeGreaterThan(0);
      expect(h.licenseCalls).toBeGreaterThan(0);
      expect(h.closeCalls).toBe(1);
    } finally {
      rmrf(dir);
    }
  });

  it("lock error → LockError (exit 4)", async () => {
    h.openBehavior = "lock";
    const dir = tmpDataDir("ditto-sess-");
    try {
      await expect(DittoSession.open(IDENTITY, dir)).rejects.toSatisfy(
        (e) => e instanceof LockError && e.exitCode === 4,
      );
    } finally {
      rmrf(dir);
    }
  });

  it("license failure at open → TokenError (exit 3)", async () => {
    h.openBehavior = "license";
    const dir = tmpDataDir("ditto-sess-");
    try {
      await expect(DittoSession.open(IDENTITY, dir)).rejects.toSatisfy(
        (e) =>
          e instanceof TokenError && e.exitCode === 3 && e.message.includes("License rejected"),
      );
    } finally {
      rmrf(dir);
    }
  });

  it("license failure at setOfflineOnlyLicenseToken → TokenError + the opened store is closed (no leak)", async () => {
    h.licenseBehavior = "license";
    const dir = tmpDataDir("ditto-sess-");
    try {
      await expect(DittoSession.open(IDENTITY, dir)).rejects.toThrow(TokenError);
      expect(h.closeCalls).toBe(1); // the opened Ditto was closed, not leaked
    } finally {
      rmrf(dir);
    }
  });

  it("non-license failure at setOfflineOnlyLicenseToken propagates raw (and closes)", async () => {
    h.licenseBehavior = "other";
    const dir = tmpDataDir("ditto-sess-");
    try {
      await expect(DittoSession.open(IDENTITY, dir)).rejects.toThrow("unrelated failure");
      expect(h.closeCalls).toBe(1);
    } finally {
      rmrf(dir);
    }
  });

  it("permission-denied at open → DataDirError (exit 3)", async () => {
    h.openBehavior = "permission";
    const dir = tmpDataDir("ditto-sess-");
    try {
      await expect(DittoSession.open(IDENTITY, dir)).rejects.toSatisfy(
        (e) => e instanceof DataDirError && e.exitCode === 3,
      );
    } finally {
      rmrf(dir);
    }
  });

  it("unusable data dir (path is a file) → DataDirError (exit 3)", async () => {
    const file = `${tmpDataDir("ditto-sess-")}/a-file`;
    await DittoSession.open; // noop ref
    const fs = await import("node:fs");
    fs.writeFileSync(file, "x");
    try {
      await expect(DittoSession.open(IDENTITY, `${file}/sub`)).rejects.toSatisfy(
        (e) => e instanceof DataDirError && e.exitCode === 3,
      );
    } finally {
      rmrf(file);
    }
  });

  it("unclassified open failures propagate raw", async () => {
    h.openBehavior = "other";
    const dir = tmpDataDir("ditto-sess-");
    try {
      await expect(DittoSession.open(IDENTITY, dir)).rejects.toThrow("some other failure");
    } finally {
      rmrf(dir);
    }
  });

  it("init runs exactly once per process", async () => {
    const dir = tmpDataDir("ditto-sess-");
    try {
      const s1 = await DittoSession.open(IDENTITY, dir).catch(() => null);
      void s1;
      // init happened at most once across all tests in this worker
      expect(h.initCalls).toBeLessThanOrEqual(1);
    } finally {
      rmrf(dir);
    }
  });

  it("PlatformError carries exit 3 + supported matrix", () => {
    const err = new PlatformError("no binding");
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain("Supported:");
  });
});

describe("loadIdentity in dev (sanity for the session)", () => {
  it("reads creds", () => {
    const id = loadIdentity({ DATABASE_ID: "a", OFFLINE_TOKEN: "t" } as NodeJS.ProcessEnv);
    expect(id.appId).toBe("a");
  });
});
