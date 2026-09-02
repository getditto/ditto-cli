import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maybeShowUpdateBanner } from "../../src/cli/update-banner.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let errSpy: ReturnType<typeof vi.spyOn>;
let state: typeof import("../../src/config/state.js");

beforeEach(async () => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.DITTO_CONFIG_DIR = tmpDataDir("ditto-state-");
  vi.resetModules();
  state = await import("../../src/config/state.js");
});

afterEach(() => {
  errSpy.mockRestore();
  rmrf(process.env.DITTO_CONFIG_DIR!);
  delete process.env.DITTO_CONFIG_DIR;
});

const stderr = () => errSpy.mock.calls.flat().join("\n");

describe("update banner", () => {
  it("shows when the cache knows a newer version", async () => {
    const hadCI = process.env.CI;
    delete process.env.CI; // GitHub Actions sets CI=true
    try {
      state.writeState({ updateCheck: { checkedAt: Date.now(), latest: "9.9.9" } });
      await maybeShowUpdateBanner("1.0.0", { isTTY: true });
      expect(stderr()).toContain("update available: 1.0.0 → 9.9.9");
      expect(stderr()).toContain("ditto update");
    } finally {
      if (hadCI !== undefined) process.env.CI = hadCI;
    }
  });

  it("is silent when current matches the cache", async () => {
    state.writeState({ updateCheck: { checkedAt: Date.now(), latest: "1.0.0" } });
    await maybeShowUpdateBanner("1.0.0", { isTTY: true });
    expect(stderr()).toBe("");
  });

  it("is silent with no cache", async () => {
    await maybeShowUpdateBanner("1.0.0", { isTTY: true });
    expect(stderr()).toBe("");
  });

  it("opt-outs: --no-update-check, quiet, CI, DITTO_NO_UPDATE_CHECK, non-TTY", async () => {
    state.writeState({ updateCheck: { checkedAt: Date.now(), latest: "9.9.9" } });
    await maybeShowUpdateBanner("1.0.0", { noCheckFlag: true, isTTY: true });
    expect(stderr()).toBe("");

    await maybeShowUpdateBanner("1.0.0", { quiet: true, isTTY: true });
    expect(stderr()).toBe("");

    process.env.CI = "1";
    try {
      await maybeShowUpdateBanner("1.0.0", { isTTY: true });
      expect(stderr()).toBe("");
    } finally {
      delete process.env.CI;
    }

    process.env.DITTO_NO_UPDATE_CHECK = "1";
    try {
      await maybeShowUpdateBanner("1.0.0", { isTTY: true });
      expect(stderr()).toBe("");
    } finally {
      delete process.env.DITTO_NO_UPDATE_CHECK;
    }
  });
});
