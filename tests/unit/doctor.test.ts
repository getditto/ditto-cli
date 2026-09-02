import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDoctorChecks } from "../../src/cli/groups/dql/doctor.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

const ENV = { DATABASE_ID: "app", OFFLINE_TOKEN: "tok" } as NodeJS.ProcessEnv;

/** Unit tests stub the store opener; the e2e suite exercises the real one. */
const openStoreOk = async () => {};
const openStoreFail = async () => {
  throw new Error("native module failed to load");
};

let dir: string;
beforeEach(() => {
  dir = tmpDataDir("ditto-doctor-");
});
afterEach(() => {
  rmrf(dir);
});

describe("collectDoctorChecks", () => {
  it("all pass on a supported platform with valid inputs", async () => {
    const checks = await collectDoctorChecks({ dataDir: dir, env: ENV, openStore: openStoreOk });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.label)).toEqual([
      "platform",
      "node",
      "data directory",
      "token",
      "sdk",
    ]);
  });

  it("fails the sdk check when the store can't open", async () => {
    const checks = await collectDoctorChecks({ dataDir: dir, env: ENV, openStore: openStoreFail });
    const s = checks.find((c) => c.label === "sdk")!;
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("native module failed to load");
  });

  it("fails unsupported platforms with a helpful message", async () => {
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["freebsd", "x64"],
      ["win32", "arm64"],
    ] as const) {
      const checks = await collectDoctorChecks({
        openStore: openStoreOk,
        platform: platform as NodeJS.Platform,
        arch,
        dataDir: dir,
        env: ENV,
      });
      const p = checks.find((c) => c.label === "platform")!;
      expect(p.ok).toBe(false);
      expect(p.detail).toContain("not supported");
    }
  });

  it("passes every SDK-supported platform/arch combo", async () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ] as const) {
      const checks = await collectDoctorChecks({
        openStore: openStoreOk,
        platform: platform as NodeJS.Platform,
        arch,
        dataDir: dir,
        env: ENV,
      });
      expect(checks.find((c) => c.label === "platform")!.ok).toBe(true);
    }
  });

  it("fails Node < 20", async () => {
    const checks = await collectDoctorChecks({
      openStore: openStoreOk,
      nodeVersion: "20.19.0",
      dataDir: dir,
      env: ENV,
    });
    const n = checks.find((c) => c.label === "node")!;
    expect(n.ok).toBe(false);
    expect(n.detail).toContain("Node 22+ required");
  });

  it("fails when the data dir is not writable (path is a file)", async () => {
    const filePath = path.join(dir, "a-file");
    fs.writeFileSync(filePath, "x", "utf8");
    const checks = await collectDoctorChecks({
      openStore: openStoreOk,
      dataDir: path.join(filePath, "sub"),
      env: ENV,
    });
    const d = checks.find((c) => c.label === "data directory")!;
    expect(d.ok).toBe(false);
    expect(d.detail).toMatch(/not writable|not creatable/);
  });

  it("fails when the data dir path is a regular file", async () => {
    const filePath = path.join(dir, "justafile");
    fs.writeFileSync(filePath, "x", "utf8");
    const checks = await collectDoctorChecks({
      dataDir: filePath,
      env: ENV,
      openStore: openStoreOk,
    });
    const d = checks.find((c) => c.label === "data directory")!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("not a directory");
  });

  it("fails on a dangling symlink as data dir", async () => {
    const link = path.join(dir, "broken-link");
    fs.symlinkSync(path.join(dir, "nonexistent-target"), link);
    const checks = await collectDoctorChecks({ dataDir: link, env: ENV, openStore: openStoreOk });
    const d = checks.find((c) => c.label === "data directory")!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("dangling symlink");
  });

  it("does not create the data dir (read-only health check)", async () => {
    const ghost = path.join(dir, "deep", "nested", "store");
    await collectDoctorChecks({ dataDir: ghost, env: ENV, openStore: openStoreOk });
    expect(fs.existsSync(ghost)).toBe(false);
  });

  it("reports token expiry when EXPIRE_ON is set", async () => {
    const checks = await collectDoctorChecks({
      openStore: openStoreOk,
      dataDir: dir,
      env: { ...ENV, EXPIRE_ON: "2027-06-01" } as NodeJS.ProcessEnv,
    });
    const t = checks.find((c) => c.label === "token")!;
    expect(t.ok).toBe(true);
    expect(t.detail).toContain("2027-06-01");
  });

  it("a valid -d flag wins precedence over a bogus DITTOSH_DATA_DIR", async () => {
    const checks = await collectDoctorChecks({
      dataDir: dir,
      env: { ...ENV, DITTOSH_DATA_DIR: "--" } as NodeJS.ProcessEnv,
      openStore: openStoreOk,
    });
    expect(checks.find((c) => c.label === "data directory")!.ok).toBe(true);
  });

  it("a whitespace-only -d flag falls through to the (bogus) env and fails", async () => {
    const checks = await collectDoctorChecks({
      dataDir: " ",
      env: { ...ENV, DITTOSH_DATA_DIR: "--" } as NodeJS.ProcessEnv,
      openStore: openStoreOk,
    });
    const d = checks.find((c) => c.label === "data directory")!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("DITTOSH_DATA_DIR");
  });

  it("flags a bogus DITTOSH_DATA_DIR when no flag overrides it", async () => {
    const checks = await collectDoctorChecks({
      env: { ...ENV, DITTOSH_DATA_DIR: "--" } as NodeJS.ProcessEnv,
      openStore: openStoreOk,
    });
    const d = checks.find((c) => c.label === "data directory")!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("DITTOSH_DATA_DIR");
  });

  it("fails the token check when credentials are missing", async () => {
    const checks = await collectDoctorChecks({
      openStore: openStoreOk,
      dataDir: dir,
      env: {} as NodeJS.ProcessEnv,
    });
    const t = checks.find((c) => c.label === "token")!;
    expect(t.ok).toBe(false);
  });
});
