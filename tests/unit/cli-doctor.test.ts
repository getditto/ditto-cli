import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureDoctorCommand,
  type DoctorDeps,
  defaultReportName,
  ISSUE_URL,
} from "../../src/cli/groups/doctor.js";
import type { DoctorCheck } from "../../src/cli/groups/dql/doctor.js";
import {
  defaultBundleName,
  registerSupportBundleCommand,
} from "../../src/cli/groups/dql/support-bundle.js";
import type { DittoSession } from "../../src/ditto/session.js";
import { recordLastError } from "../../src/support/last-error.js";
import type { StoreSession } from "../../src/support/report.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

const TOKEN = "unit-test-offline-token-123";
const BUNDLE_ROW = {
  _id: { pk: "pk1", created_at: "2026-11-07T12:00:00+00:00" },
  reason: "USER_INITIATED",
  file: { id: "att1", len: 2048, metadata: {} },
};

let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = tmpDataDir("ditto-doctor-cli-");
  process.env.DATABASE_ID = "test-app";
  process.env.OFFLINE_TOKEN = TOKEN;
  process.env.DITTOSH_CONFIG_DIR = path.join(dir, "cfg");
  process.exitCode = undefined;
  outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  process.env = savedEnv;
  rmrf(dir);
  process.exitCode = undefined;
});

const stdout = () => outSpy.mock.calls.flat().join("\n");
const stderr = () => errSpy.mock.calls.flat().join("\n");

function fakeSession(opts: { requestFails?: Error; existing?: unknown[] } = {}) {
  const calls: string[] = [];
  let closed = false;
  const session = {
    async execute(statement: string) {
      calls.push(statement);
      if (statement.startsWith("EXECUTE FUNCTION")) {
        if (opts.requestFails) throw opts.requestFails;
        return { items: [{ value: BUNDLE_ROW }] };
      }
      if (statement.startsWith("SELECT * FROM system:support_bundles")) {
        return { items: (opts.existing ?? []).map((value) => ({ value })) };
      }
      if (statement === "SELECT * FROM system:collections") {
        return { items: [{ value: { name: "movies" } }] };
      }
      if (statement.startsWith("SELECT COUNT")) return { items: [{ value: { n: 7 } }] };
      return { items: [] };
    },
    async saveAttachment(_token: unknown, file: string) {
      fs.writeFileSync(file, "tar-bytes");
    },
    async close() {
      closed = true;
    },
  };
  return { session, calls, closed: () => closed };
}

function deps(checks: DoctorCheck[], store?: StoreSession): DoctorDeps {
  return {
    collectChecks: async () => checks,
    openStore: async () => store ?? fakeSession().session,
    channelDetail: () => "npm (/usr/local)",
    now: () => new Date(2026, 10, 7, 9, 5, 3),
  };
}

const OK: DoctorCheck[] = [{ ok: true, label: "platform", detail: "fine" }];

async function runDoctor(d: DoctorDeps, ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  configureDoctorCommand(program.command("doctor"), d);
  await program.parseAsync(["node", "dittosh", "doctor", ...args]);
}

async function entries(file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await tar.t({
    file,
    onReadEntry: (e) => {
      const chunks: Buffer[] = [];
      e.on("data", (c: Buffer) => chunks.push(c));
      e.on("end", () => out.set(e.path, Buffer.concat(chunks).toString("utf8")));
    },
  });
  return out;
}

function makeStore(): string {
  const store = path.join(dir, "store");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "__ditto_lock_file"), "");
  return store;
}

describe("dittosh doctor", () => {
  it("prints checks and sets the exit code (3 for a failure, 4 for a lock)", async () => {
    await runDoctor(deps(OK));
    expect(stdout()).toContain("platform — fine");
    expect(process.exitCode).toBe(0);

    await runDoctor(deps([{ ok: false, label: "node", detail: "old" }]));
    expect(process.exitCode).toBe(3);

    await runDoctor(deps([{ ok: false, label: "lock", detail: "held" }]));
    expect(process.exitCode).toBe(4);
  });

  it("--report writes a redacted bundle with the report, SDK bundle, and last error", async () => {
    const store = makeStore();
    recordLastError(
      {
        time: "2026-11-07T08:00:00Z",
        version: "0.2.0",
        command: ["dql", "SELEC"],
        exitCode: 1,
        stderr: [`failed in ${os.homedir()}/project`],
      },
      path.join(dir, "cfg"),
    );
    const f = fakeSession();
    const out = path.join(dir, "out", "my-report.tar.gz");
    await runDoctor(deps(OK, f.session), "-d", store, "--report", out);
    expect(process.exitCode).toBe(0);
    expect(f.closed()).toBe(true);

    const files = await entries(out);
    expect([...files.keys()].sort()).toEqual([
      "my-report/",
      "my-report/ditto-support-bundle.tar",
      "my-report/report.json",
      "my-report/report.md",
    ]);
    const md = files.get("my-report/report.md")!;
    expect(md).toContain("| dittosh |");
    expect(md).toContain("| installed | npm (/usr/local) |");
    expect(md).toContain("| movies | 7 |");
    expect(md).toContain("`dittosh dql SELEC` exited 1");
    expect(md).toContain("failed in ~/project");
    expect(md).toContain("| OFFLINE_TOKEN | set (value hidden) |");
    const all = [...files.values()].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(`${os.homedir()}/`);
    JSON.parse(files.get("my-report/report.json")!);

    expect(stderr()).toContain("Wrote");
    expect(stderr()).toContain("It contains:");
    expect(stderr()).toContain(ISSUE_URL);
    expect(stdout()).not.toContain("Wrote"); // status stays off stdout
  });

  it("--report with no file name uses a timestamped name in the current folder", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await runDoctor(deps(OK), "-d", path.join(dir, "none"), "--report", "--no-sdk-bundle");
    } finally {
      process.chdir(cwd);
    }
    const file = path.join(dir, "dittosh-report-20261107-090503.tar.gz");
    expect(fs.existsSync(file)).toBe(true);
    const md = (await entries(file)).get("dittosh-report-20261107-090503/report.md")!;
    expect(md).toContain("left out (--no-sdk-bundle)");
    expect(md).toContain("no store at the data directory yet");
    expect(stderr()).toContain("no SDK support bundle");
  });

  it("--no-store leaves out the store summary", async () => {
    const store = makeStore();
    const out = path.join(dir, "r.tar.gz");
    await runDoctor(deps(OK), "-d", store, "--report", out, "--no-store");
    const md = (await entries(out)).get("r/report.md")!;
    expect(md).toContain("left out (--no-store)");
    expect(md).toContain("ditto-support-bundle.tar");
  });

  it("reports a missing license token instead of failing", async () => {
    delete process.env.OFFLINE_TOKEN;
    delete process.env.DQL_OFFLINE_LICENSE;
    const store = makeStore();
    const out = path.join(dir, "r.tar.gz");
    await runDoctor(deps(OK), "-d", store, "--report", out);
    const md = (await entries(out)).get("r/report.md")!;
    expect(md).toMatch(/\| token expires \| unavailable/);
    expect(md).toContain("no license token loaded");
  });

  it("exits 1 when the report can't be written", async () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    await runDoctor(
      deps(OK),
      "-d",
      path.join(dir, "none"),
      "--report",
      path.join(blocker, "r.tar.gz"),
    );
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Could not write the report");
  });

  it("names reports and bundles by local time", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(defaultReportName(d)).toBe("dittosh-report-20260102-030405.tar.gz");
    expect(defaultBundleName(d)).toBe("ditto-support-bundle-20260102-030405.tar");
  });
});

describe("dittosh dql support-bundle", () => {
  async function runBundle(session: unknown, ...args: string[]) {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const dql = program.command("dql");
    registerSupportBundleCommand(dql, {
      openSession: async () => session as DittoSession | null,
      now: () => new Date(2026, 10, 7, 9, 5, 3),
    });
    await program.parseAsync(["node", "dittosh", "dql", "support-bundle", ...args]);
  }

  it("saves a bundle to -o and notes where", async () => {
    const f = fakeSession();
    const out = path.join(dir, "sub", "b.tar");
    await runBundle(f.session, "-o", out);
    expect(fs.readFileSync(out, "utf8")).toBe("tar-bytes");
    expect(f.calls[0]).toContain("system_request_support_bundle");
    expect(stderr()).toContain("Saved");
    expect(stderr()).toContain("2.0 KB");
    expect(f.closed()).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("uses a timestamped default name", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await runBundle(fakeSession().session);
    } finally {
      process.chdir(cwd);
    }
    expect(fs.existsSync(path.join(dir, "ditto-support-bundle-20261107-090503.tar"))).toBe(true);
  });

  it("falls back to the newest bundle when the rate limit is hit", async () => {
    const f = fakeSession({ requestFails: new Error("rate exceeded"), existing: [BUNDLE_ROW] });
    await runBundle(f.session, "-o", path.join(dir, "b.tar"));
    expect(stderr()).toContain("A new bundle wasn't allowed (rate exceeded)");
  });

  it("exits 1 with the SDK's reason when nothing can be saved", async () => {
    const f = fakeSession({ requestFails: new Error("rate exceeded") });
    await runBundle(f.session, "-o", path.join(dir, "b.tar"));
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain("Could not save a support bundle: rate exceeded");
    expect(f.closed()).toBe(true);
  });

  it("refuses to overwrite a file", async () => {
    const out = path.join(dir, "b.tar");
    fs.writeFileSync(out, "keep");
    await runBundle(fakeSession().session, "-o", out);
    expect(process.exitCode).toBe(2);
    expect(fs.readFileSync(out, "utf8")).toBe("keep");
  });

  it("--list prints the bundles, or a note when there are none", async () => {
    await runBundle(fakeSession({ existing: [BUNDLE_ROW] }).session, "--list", "--format", "json");
    expect(JSON.parse(stdout())).toEqual([
      { created_at: "2026-11-07T12:00:00+00:00", reason: "USER_INITIATED", bytes: 2048 },
    ]);
    outSpy.mockClear();
    await runBundle(fakeSession().session, "--list");
    expect(stdout()).toBe("");
    expect(stderr()).toContain("No support bundles");
  });

  it("rejects a bad --format, and --format without --list", async () => {
    await runBundle(fakeSession().session, "--list", "--format", "yaml");
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await runBundle(fakeSession().session, "--format", "json");
    expect(process.exitCode).toBe(2);
    expect(stderr()).toContain("--format only applies with --list");
  });

  it("does nothing more when the store can't open", async () => {
    await runBundle(null, "-o", path.join(dir, "b.tar"));
    expect(fs.existsSync(path.join(dir, "b.tar"))).toBe(false);
  });
});
