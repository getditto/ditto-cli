import type { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { pageIfLong } from "../../src/render/pager.js";

type Spawn = typeof spawnSync;

function fakeSpawn(result: { status?: number | null; error?: Error }) {
  return vi.fn(
    () => ({ ...result, pid: 1, output: [], signal: null }) as unknown as ReturnType<Spawn>,
  );
}

const longText = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
const tty = { isTTY: true, termRows: 24, env: {} as NodeJS.ProcessEnv };

describe("pageIfLong", () => {
  it("pages long TTY output through less by default", () => {
    const spawn = fakeSpawn({ status: 0 });
    const paged = pageIfLong(longText, { ...tty, spawn: spawn as unknown as Spawn });
    expect(paged).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "less",
      ["-SRF"],
      expect.objectContaining({ input: longText }),
    );
  });

  it("uses $PAGER through the shell when set", () => {
    const spawn = fakeSpawn({ status: 0 });
    const paged = pageIfLong(longText, {
      ...tty,
      env: { PAGER: "most -d" } as NodeJS.ProcessEnv,
      spawn: spawn as unknown as Spawn,
    });
    expect(paged).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "most -d",
      expect.objectContaining({ shell: true, input: longText }),
    );
  });

  it("skips short output", () => {
    const spawn = fakeSpawn({ status: 0 });
    expect(pageIfLong("one\ntwo", { ...tty, spawn: spawn as unknown as Spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips when stdout is not a TTY", () => {
    const spawn = fakeSpawn({ status: 0 });
    expect(pageIfLong(longText, { ...tty, isTTY: false, spawn: spawn as unknown as Spawn })).toBe(
      false,
    );
  });

  it("skips when disabled (--no-pager)", () => {
    const spawn = fakeSpawn({ status: 0 });
    expect(pageIfLong(longText, { ...tty, disabled: true, spawn: spawn as unknown as Spawn })).toBe(
      false,
    );
  });

  it("skips on DITTOSH_NO_PAGER=1/true/yes", () => {
    const spawn = fakeSpawn({ status: 0 });
    for (const v of ["1", "true", "yes"]) {
      expect(
        pageIfLong(longText, {
          ...tty,
          env: { DITTOSH_NO_PAGER: v } as NodeJS.ProcessEnv,
          spawn: spawn as unknown as Spawn,
        }),
      ).toBe(false);
    }
  });

  it("falls back to direct printing when no pager exists (ENOENT)", () => {
    const spawn = fakeSpawn({ error: new Error("spawn less ENOENT") });
    expect(pageIfLong(longText, { ...tty, spawn: spawn as unknown as Spawn })).toBe(false);
  });

  it("treats a non-zero pager exit as shown (no double-print)", () => {
    const spawn = fakeSpawn({ status: 1 });
    expect(pageIfLong(longText, { ...tty, spawn: spawn as unknown as Spawn })).toBe(true);
  });
});
