import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSystemGroup } from "../../src/cli/groups/system/index.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  process.env.DITTOSH_CONFIG_DIR = tmpDataDir("ditto-state-");
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmrf(process.env.DITTOSH_CONFIG_DIR!);
  delete process.env.DITTOSH_CONFIG_DIR;
});

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

function buildProgram(deps: Parameters<typeof registerSystemGroup>[1]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSystemGroup(program, deps);
  return program;
}

const noUpdate = {
  current: "0.1.0",
  latest: "0.1.0",
  updateAvailable: false,
  fromCache: true,
};

describe("ditto version", () => {
  it("prints version, channel, token expiry, data dir, platform, node", async () => {
    const program = buildProgram({
      checkForUpdate: async () => noUpdate,
      readCachedUpdate: () => ({ checkedAt: Date.now(), latest: "0.1.0" }),
      detectChannel: () => ({
        channel: "npm",
        updateCommand: "npm i -g @dittolive/cli@latest",
        detail: "npm global",
      }),
      run: () => 0,
      env: {
        DATABASE_ID: "app",
        OFFLINE_TOKEN: "tok",
        EXPIRE_ON: "2027-06-01",
      } as NodeJS.ProcessEnv,
    });
    await program.parseAsync(["node", "ditto", "version"]);
    const out = stdout();
    for (const key of [
      "version",
      "ditto_sdk",
      "channel",
      "update",
      "token_expires",
      "data_dir",
      "platform",
      "node",
    ]) {
      expect(out).toContain(key);
    }
    expect(out).toContain("npm global");
    expect(out).toContain("2027-06-01");
    expect(out).toContain("up to date");
  });

  it("--format json emits a JSON object", async () => {
    const program = buildProgram({
      checkForUpdate: async () => noUpdate,
      readCachedUpdate: () => undefined,
      detectChannel: () => ({ channel: "unknown", updateCommand: null, detail: "dev checkout" }),
      run: () => 0,
      env: {} as NodeJS.ProcessEnv,
    });
    await program.parseAsync(["node", "ditto", "version", "--format", "json"]);
    const parsed = JSON.parse(stdout());
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("ditto_sdk");
    expect(parsed).toHaveProperty("channel");
    expect(parsed).toHaveProperty("token_expires");
  });

  it("no cache → never checked (version is offline)", async () => {
    const program = buildProgram({
      checkForUpdate: async () => {
        throw new Error("offline");
      },
      readCachedUpdate: () => undefined,
      detectChannel: () => ({ channel: "unknown", updateCommand: null, detail: "dev checkout" }),
      run: () => 0,
      env: {} as NodeJS.ProcessEnv,
    });
    await program.parseAsync(["node", "ditto", "version"]);
    expect(stdout()).toContain("never checked");
    expect(process.exitCode).toBeUndefined();
  });
});

describe("ditto update", () => {
  const newer = { current: "0.1.0", latest: "0.2.0", updateAvailable: true, fromCache: false };

  it("no update available → friendly message, exit 0", async () => {
    const program = buildProgram({
      checkForUpdate: async () => noUpdate,
      readCachedUpdate: () => undefined,
      detectChannel: () => ({
        channel: "npm",
        updateCommand: "npm i -g @dittolive/cli@latest",
        detail: "npm global",
      }),
      run: vi.fn(() => 0),
    });
    await program.parseAsync(["node", "ditto", "update"]);
    expect(stdout()).toContain("up to date");
    expect(process.exitCode).toBeUndefined();
  });

  it("--check prints the upgrade command without running it", async () => {
    const run = vi.fn(() => 0);
    const program = buildProgram({
      checkForUpdate: async () => newer,
      readCachedUpdate: () => undefined,
      detectChannel: () => ({
        channel: "homebrew",
        updateCommand: "brew update && brew upgrade dittosh",
        detail: "homebrew (/opt/homebrew)",
      }),
      run,
    });
    await program.parseAsync(["node", "ditto", "update", "--check"]);
    expect(stdout()).toContain("0.1.0 → 0.2.0");
    expect(stderr()).toContain("brew update && brew upgrade dittosh");
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the channel's upgrade command", async () => {
    const run = vi.fn(() => 0);
    const program = buildProgram({
      checkForUpdate: async () => newer,
      readCachedUpdate: () => undefined,
      detectChannel: () => ({
        channel: "npm",
        updateCommand: "npm i -g @dittolive/cli@latest",
        detail: "npm global",
      }),
      run,
    });
    await program.parseAsync(["node", "ditto", "update"]);
    expect(run).toHaveBeenCalledWith("npm i -g @dittolive/cli@latest");
    expect(stdout()).toContain("Updated to 0.2.0");
  });

  it("unknown channel → manual instructions, exit 1", async () => {
    const run = vi.fn(() => 0);
    const program = buildProgram({
      checkForUpdate: async () => newer,
      readCachedUpdate: () => undefined,
      detectChannel: () => ({ channel: "unknown", updateCommand: null, detail: "unknown" }),
      run,
    });
    await program.parseAsync(["node", "ditto", "update"]);
    expect(run).not.toHaveBeenCalled();
    expect(stderr()).toContain("brew update && brew upgrade dittosh");
    expect(stderr()).toContain("npm i -g @dittolive/cli@latest");
    expect(process.exitCode).toBe(1);
  });

  it("failed upgrade command exits 1 with a manual hint", async () => {
    const run = vi.fn(() => 1);
    const program = buildProgram({
      checkForUpdate: async () => newer,
      readCachedUpdate: () => undefined,
      detectChannel: () => ({
        channel: "npm",
        updateCommand: "npm i -g @dittolive/cli@latest",
        detail: "npm global",
      }),
      run,
    });
    await program.parseAsync(["node", "ditto", "update"]);
    expect(stderr()).toContain("failed");
    expect(process.exitCode).toBe(1);
  });

  it("registry failure exits 1 with the message", async () => {
    const program = buildProgram({
      checkForUpdate: async () => {
        throw new Error("offline");
      },
      readCachedUpdate: () => undefined,
      detectChannel: () => ({
        channel: "npm",
        updateCommand: "npm i -g @dittolive/cli@latest",
        detail: "npm global",
      }),
      run: vi.fn(),
    });
    await program.parseAsync(["node", "ditto", "update"]);
    expect(stderr()).toContain("Update check failed: offline");
    expect(process.exitCode).toBe(1);
  });
});
