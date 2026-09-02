import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let state: typeof import("../../src/config/state.js");
let check: typeof import("../../src/update/check.js");

beforeEach(async () => {
  process.env.DITTOSH_CONFIG_DIR = tmpDataDir("ditto-state-");
  vi.resetModules();
  state = await import("../../src/config/state.js");
  check = await import("../../src/update/check.js");
});

afterEach(() => {
  rmrf(process.env.DITTOSH_CONFIG_DIR!);
  delete process.env.DITTOSH_CONFIG_DIR;
});

describe("update check", () => {
  it("fresh cache wins without hitting the network", async () => {
    state.writeState({ updateCheck: { checkedAt: Date.now(), latest: "9.9.9" } });
    const fetchFn = vi.fn();
    const status = await check!.checkForUpdate("1.0.0", { fetchFn: fetchFn as never });
    expect(status).toMatchObject({
      current: "1.0.0",
      latest: "9.9.9",
      updateAvailable: true,
      fromCache: true,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stale cache refreshes from the registry and updates the cache", async () => {
    state.writeState({
      updateCheck: { checkedAt: Date.now() - 25 * 60 * 60 * 1000, latest: "1.0.0" },
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.1.0" }),
    });
    const status = await check!.checkForUpdate("1.0.0", { fetchFn: fetchFn as never });
    expect(status).toMatchObject({ latest: "1.1.0", updateAvailable: true, fromCache: false });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(state.readState().updateCheck).toMatchObject({ latest: "1.1.0" });
  });

  it("no update when registry matches current", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ version: "1.0.0" }) });
    const status = await check!.checkForUpdate("1.0.0", { fetchFn: fetchFn as never });
    expect(status?.updateAvailable).toBe(false);
  });

  it("registry failure propagates (callers catch silently)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(check!.checkForUpdate("1.0.0", { fetchFn: fetchFn as never })).rejects.toThrow(
      "offline",
    );
  });

  it("corrupt cache is ignored and refetched", async () => {
    state.writeState({ updateCheck: "garbage" });
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ version: "2.0.0" }) });
    const status = await check!.checkForUpdate("1.0.0", { fetchFn: fetchFn as never });
    expect(status?.fromCache).toBe(false);
  });
});

describe("isNewer", () => {
  it.each([
    ["1.0.0", "1.0.1", true],
    ["1.0.0", "2.0.0", true],
    ["1.0.1", "1.1.0", true],
    ["2.0.0", "1.9.9", false],
    ["1.0.0", "1.0.0", false],
    ["1.0.0", "1.0.0-beta", false], // prerelease compares older
    ["1.0.0-beta", "1.0.0", true],
  ])("isNewer(%s, %s) === %s", (current, latest, expected) => {
    expect(check!.isNewer(current, latest)).toBe(expected);
  });
});

describe("updateCheckAllowed opt-outs", () => {
  it("respects every opt-out", () => {
    // GitHub Actions sets CI=true — control it explicitly in this test
    const hadCI = process.env.CI;
    delete process.env.CI;
    try {
      expect(check!.updateCheckAllowed({ isTTY: true })).toBe(true);
      expect(check!.updateCheckAllowed({ isTTY: false })).toBe(false);
      expect(check!.updateCheckAllowed({ isTTY: true, quiet: true })).toBe(false);
      expect(check!.updateCheckAllowed({ isTTY: true, jsonOut: true })).toBe(false);
      expect(check!.updateCheckAllowed({ isTTY: true, ci: true })).toBe(false);
      process.env.DITTOSH_NO_UPDATE_CHECK = "1";
      try {
        expect(check!.updateCheckAllowed({ isTTY: true })).toBe(false);
      } finally {
        delete process.env.DITTOSH_NO_UPDATE_CHECK;
      }
    } finally {
      if (hadCI !== undefined) process.env.CI = hadCI;
    }
  });
});
