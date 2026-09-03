import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deleteStore } from "../../src/cli/groups/dql/delete-store.js";
import { LockError } from "../../src/ditto/session.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/** A fake initialized store dir (lock file + a data file). */
function fakeStore(): string {
  const dir = tmpDataDir("ditto-delete-");
  fs.writeFileSync(path.join(dir, "__ditto_lock_file"), "");
  fs.writeFileSync(path.join(dir, "data.sqlite"), "x");
  return dir;
}

describe("deleteStore", () => {
  it("missing dir → 0, nothing to delete", async () => {
    const dir = path.join(tmpDataDir("ditto-delete-"), "nope");
    const r = await deleteStore({ dataDir: dir, yes: true });
    expect(r.code).toBe(0);
    expect(r.message).toContain("nothing to delete");
    rmrf(path.dirname(dir));
  });

  it("without --yes → 2 and the store is untouched", async () => {
    const dir = fakeStore();
    try {
      const r = await deleteStore({ dataDir: dir });
      expect(r.code).toBe(2);
      expect(r.message).toContain("--yes");
      expect(fs.existsSync(path.join(dir, "data.sqlite"))).toBe(true);
    } finally {
      rmrf(dir);
    }
  });

  it("--yes deletes the whole directory (lock file, data, everything)", async () => {
    const dir = fakeStore();
    const probeLock = vi.fn(async () => {});
    const r = await deleteStore({ dataDir: dir, yes: true, probeLock });
    expect(r.code).toBe(0);
    expect(r.message).toContain("Deleted");
    expect(fs.existsSync(dir)).toBe(false);
    expect(probeLock).toHaveBeenCalledWith(dir);
  });

  it("skips the lock probe when no lock file exists", async () => {
    const dir = tmpDataDir("ditto-delete-"); // no __ditto_lock_file
    const probeLock = vi.fn(async () => {});
    const r = await deleteStore({ dataDir: dir, yes: true, probeLock });
    expect(r.code).toBe(0);
    expect(probeLock).not.toHaveBeenCalled();
  });

  it("a held lock → 4 and the store is untouched", async () => {
    const dir = fakeStore();
    try {
      const r = await deleteStore({
        dataDir: dir,
        yes: true,
        probeLock: async () => {
          throw new LockError(dir);
        },
      });
      expect(r.code).toBe(4);
      expect(r.message).toContain("in use by another dittosh process");
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      rmrf(dir);
    }
  });

  it("non-lock probe failures (expired token, SDK unavailable) don't block deletion", async () => {
    const dir = fakeStore();
    const r = await deleteStore({
      dataDir: dir,
      yes: true,
      probeLock: async () => {
        throw new Error("License rejected: token expired");
      },
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses to delete root, home, or the cwd", async () => {
    for (const dir of [path.parse(process.cwd()).root, os.homedir(), process.cwd()]) {
      const r = await deleteStore({ dataDir: dir, yes: true });
      expect(r.code).toBe(2);
      expect(r.message).toContain("Refusing");
    }
  });

  it("bogus -d and bogus DITTOSH_DATA_DIR are usage errors", async () => {
    expect((await deleteStore({ dataDir: "--", yes: true })).code).toBe(2);
    expect((await deleteStore({ env: { DITTOSH_DATA_DIR: "--" }, yes: true })).code).toBe(2);
  });

  it("honors DITTOSH_DATA_DIR when -d is absent", async () => {
    const dir = fakeStore();
    const r = await deleteStore({
      env: { DITTOSH_DATA_DIR: dir },
      yes: true,
      probeLock: async () => {},
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("rm failure → 3", async () => {
    const dir = fakeStore();
    try {
      const r = await deleteStore({
        dataDir: dir,
        yes: true,
        probeLock: async () => {},
        rm: () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      });
      expect(r.code).toBe(3);
      expect(r.message).toContain("permission denied");
    } finally {
      rmrf(dir);
    }
  });
});
