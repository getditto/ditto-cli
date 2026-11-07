import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { type TutorialContext, tutorialSections } from "../../src/tutorial/content.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf } from "../helpers/credentials.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TSX = pathToFileURL(path.join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const ENTRY = path.join(ROOT, "src/cli/index.ts");

function cli(args: string[], opts: { cwd?: string } = {}) {
  return execa(process.execPath, ["--import", TSX, ENTRY, ...args], {
    cwd: opts.cwd ?? ROOT,
    reject: false,
    env: { DITTOSH_NO_UPDATE_CHECK: "1" },
  });
}

const CTX: TutorialContext = {
  cliVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  sdkVersion: "5.2.0",
  channel: "npm",
  platform: `${process.platform}/${process.arch}`,
  generatedOn: "2026-11-06",
};

describe("e2e: dittosh tutorial (Markdown generator)", () => {
  it("writes the tutorial file, refuses to overwrite without --force", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-tut-"));
    try {
      const first = await cli(["tutorial"], { cwd: dir });
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe("");
      expect(first.stderr).toContain("Wrote the tutorial to");
      const md = fs.readFileSync(path.join(dir, "dittosh-tutorial.md"), "utf8");
      expect(md).toMatch(/^# Ditto CLI: a hands-on tutorial/);
      expect(md).toContain("What's new in DQL (Ditto SDK 5.2)");
      expect(md).toContain("dittosh tutorial --interactive");

      const again = await cli(["tutorial"], { cwd: dir });
      expect(again.exitCode).toBe(2);
      expect(again.stderr).toContain("--force");

      const forced = await cli(["tutorial", "--force", "-o", "custom.md"], { cwd: dir });
      expect(forced.exitCode).toBe(0);
      expect(fs.existsSync(path.join(dir, "custom.md"))).toBe(true);
    } finally {
      rmrf(dir);
    }
  });

  it("--stdout prints the Markdown; --interactive needs a terminal", async () => {
    const r = await cli(["tutorial", "--stdout"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("## 1. Check your installation");

    const both = await cli(["tutorial", "--stdout", "--out", "x.md"]);
    expect(both.exitCode).toBe(2);

    for (const flag of [["--level", "advanced"], ["--plain"]]) {
      const stray = await cli(["tutorial", ...flag]);
      expect(stray.exitCode).toBe(2);
      expect(stray.stderr).toContain("only apply with --interactive");
    }

    const notty = await cli(["tutorial", "--interactive"]);
    expect(notty.exitCode).toBe(2);
    expect(notty.stderr).toContain("need a terminal");
  });
});

/**
 * Runs every runnable bash block of the generated tutorial, in order, in one
 * bash process — exactly as a reader would — with `dittosh` pointing at this
 * checkout. Catches tutorial commands that drift out of date.
 */
describe.skipIf(!hasDevCredentials)(
  `e2e: tutorial commands run as written (${NO_CREDENTIALS})`,
  () => {
    it("every runnable block succeeds and shows its expected output", async () => {
      const blocks = tutorialSections(CTX).flatMap((s, si) =>
        s.blocks.flatMap((b, bi) =>
          b.kind === "code" && b.run ? [{ id: `${si + 1}.${bi}`, title: s.title, ...b }] : [],
        ),
      );
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dittosh-tut-run-"));
      const script = [
        "set -euo pipefail",
        `dittosh() { "${process.execPath}" --import "${TSX}" "${ENTRY}" "$@"; }`,
        ...blocks.flatMap((b) => [`echo "@@BLOCK ${b.id}"`, b.code]),
        'echo "@@END"',
      ].join("\n");
      try {
        const r = await execa("bash", ["-c", script], {
          cwd: tmp,
          reject: false,
          env: { TMPDIR: tmp, DITTOSH_NO_UPDATE_CHECK: "1" },
        });
        const failedAt = r.stdout.match(/@@BLOCK (\S+)(?![\s\S]*@@BLOCK)/)?.[1];
        expect(
          r.exitCode,
          `tutorial failed in block ${failedAt}:\n${r.stderr.split("\n").slice(-15).join("\n")}`,
        ).toBe(0);
        expect(r.stdout).toContain("@@END");
        const outputs = new Map<string, string>();
        for (const part of r.stdout.split("@@BLOCK ").slice(1)) {
          const nl = part.indexOf("\n");
          outputs.set(part.slice(0, nl), part.slice(nl + 1));
        }
        for (const b of blocks) {
          for (const want of b.expect ?? []) {
            expect(outputs.get(b.id), `block ${b.id} (${b.title}) should print ${want}`).toContain(
              want,
            );
          }
        }
      } finally {
        rmrf(tmp);
      }
    }, 300_000);
  },
);
