import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { collectDoctorChecks } from "../../src/cli/groups/dql/doctor.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

const ENV = { DATABASE_ID: "app", OFFLINE_TOKEN: "tok" } as NodeJS.ProcessEnv;

let dir: string;
beforeEach(() => {
  dir = tmpDataDir("ditto-doctor-");
});
afterEach(() => {
  rmrf(dir);
});

describe("collectDoctorChecks", () => {
  it("all pass on a supported platform with valid inputs", async () => {
    const checks = await collectDoctorChecks({ dataDir: dir, env: ENV });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.label)).toEqual(["platform", "node", "data directory", "token"]);
  });

  it("fails unsupported platforms with a helpful message", async () => {
    for (const [platform, arch] of [["darwin", "x64"], ["freebsd", "x64"], ["win32", "arm64"]] as const) {
      const checks = await collectDoctorChecks({ platform: platform as NodeJS.Platform, arch, dataDir: dir, env: ENV });
      const p = checks.find((c) => c.label === "platform")!;
      expect(p.ok).toBe(false);
      expect(p.detail).toContain("not supported");
    }
  });

  it("passes every SDK-supported platform/arch combo", async () => {
    for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]] as const) {
      const checks = await collectDoctorChecks({ platform: platform as NodeJS.Platform, arch, dataDir: dir, env: ENV });
      expect(checks.find((c) => c.label === "platform")!.ok).toBe(true);
    }
  });

  it("fails Node < 20", async () => {
    const checks = await collectDoctorChecks({ nodeVersion: "18.19.0", dataDir: dir, env: ENV });
    const n = checks.find((c) => c.label === "node")!;
    expect(n.ok).toBe(false);
    expect(n.detail).toContain("Node 20+ required");
  });

  it("fails when the data dir is not writable (path is a file)", async () => {
    const filePath = path.join(dir, "a-file");
    fs.writeFileSync(filePath, "x", "utf8");
    const checks = await collectDoctorChecks({ dataDir: path.join(filePath, "sub"), env: ENV });
    const d = checks.find((c) => c.label === "data directory")!;
    expect(d.ok).toBe(false);
    expect(d.detail).toContain("not writable");
  });

  it("reports token expiry when EXPIRE_ON is set", async () => {
    const checks = await collectDoctorChecks({ dataDir: dir, env: { ...ENV, EXPIRE_ON: "2027-06-01" } as NodeJS.ProcessEnv });
    const t = checks.find((c) => c.label === "token")!;
    expect(t.ok).toBe(true);
    expect(t.detail).toContain("2027-06-01");
  });

  it("fails the token check when credentials are missing", async () => {
    const checks = await collectDoctorChecks({ dataDir: dir, env: {} as NodeJS.ProcessEnv });
    const t = checks.find((c) => c.label === "token")!;
    expect(t.ok).toBe(false);
  });
});
