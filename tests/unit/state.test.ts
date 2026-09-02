import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

// Point the config dir at an isolated location before importing the module
// under test (env-paths caches homedir at module load, so DITTO_CONFIG_DIR is
// the reliable lever).
let home: string;
let state: typeof import("../../src/config/state.js");

beforeEach(async () => {
  home = tmpDataDir("ditto-state-");
  process.env.DITTO_CONFIG_DIR = home;
  vi.resetModules();
  state = await import("../../src/config/state.js");
});

afterEach(() => {
  rmrf(home);
});

function walkForState(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkForState(full));
    else if (entry.name === "state.json") found.push(full);
  }
  return found;
}

describe("state store", () => {
  it("returns {} when no state file exists", () => {
    expect(state.readState()).toEqual({});
  });

  it("persists patches across reads", () => {
    state.writeState({ noLimitWarned: true });
    expect(state.readState().noLimitWarned).toBe(true);
  });

  it("merges patches without losing existing keys", () => {
    state.writeState({ noLimitWarned: true });
    state.writeState({ other: 42 });
    expect(state.readState()).toEqual({ noLimitWarned: true, other: 42 });
  });

  it("recovers from a corrupt state file", () => {
    state.writeState({ probe: 1 });
    expect(state.readState().probe).toBe(1);
    const files = walkForState(home);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) fs.writeFileSync(f, "not json{{{", "utf8");
    expect(state.readState()).toEqual({});
  });

  it('a file containing "null" is not state (regression: null.noLimitWarned crash)', () => {
    state.writeState({ probe: 1 });
    for (const f of walkForState(home)) fs.writeFileSync(f, "null", "utf8");
    expect(state.readState()).toEqual({});
  });

  // chmod-based read-only enforcement is posix-only
  it.skipIf(process.platform === "win32")(
    "writeState never throws, even on a read-only config dir",
    () => {
      state.writeState({ probe: 1 });
      const file = walkForState(home)[0]!;
      fs.chmodSync(home, 0o444);
      try {
        expect(() => state.writeState({ probe: 2 })).not.toThrow();
      } finally {
        fs.chmodSync(home, 0o755);
      }
      expect(fs.readFileSync(file, "utf8")).toContain('"probe": 1'); // unchanged
    },
  );
});
