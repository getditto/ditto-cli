import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPracticeStore,
  markPracticeStore,
  PRACTICE_MARKER,
  practiceStoreDir,
} from "../../src/tutorial/practice-store.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-practice-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("practice store guard", () => {
  const own = "/cfg/tutorial-store";

  it("a blank or missing -d means the tutorial's own store, never the default dql store", () => {
    for (const flag of [undefined, "", "  ", "=", "= "]) {
      expect(practiceStoreDir(flag, own), JSON.stringify(flag)).toBe(own);
    }
    expect(practiceStoreDir("=/tmp/x", own)).toBe(path.resolve("/tmp/x"));
    expect(practiceStoreDir("~/learn", own)).toBe(path.join(os.homedir(), "learn"));
  });

  it("allows the tutorial's own store, a new or empty directory, or a marked one", () => {
    expect(checkPracticeStore(own, own)).toEqual({ ok: true });
    const base = tmp();
    expect(checkPracticeStore(path.join(base, "new"), own)).toEqual({ ok: true });
    expect(checkPracticeStore(base, own)).toEqual({ ok: true });
    fs.writeFileSync(path.join(base, "ditto.db"), "x");
    markPracticeStore(base);
    expect(fs.existsSync(path.join(base, PRACTICE_MARKER))).toBe(true);
    expect(checkPracticeStore(base, own)).toEqual({ ok: true });
  });

  it("refuses an existing store the lessons didn't create", () => {
    const real = tmp();
    fs.writeFileSync(path.join(real, "ditto.db"), "user data");
    const r = checkPracticeStore(real, own);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("isn't a lesson practice store");
    // A file where a directory is expected can't be read as a store.
    const file = path.join(real, "ditto.db");
    expect(checkPracticeStore(file, own).ok).toBe(false);
    // Marking a path that can't be written is best effort and doesn't throw.
    expect(() => markPracticeStore(path.join(file, "nested"))).not.toThrow();
  });
});
