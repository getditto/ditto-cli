import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoctorCheck } from "../../src/cli/groups/dql/doctor.js";
import { sdkDebugLevel } from "../../src/ditto/session.js";
import { writeArchive } from "../../src/support/archive.js";
import {
  isDiagnosticCommand,
  LAST_ERROR_FILE,
  type LastError,
  readLastError,
  recordLastError,
  startStderrTail,
} from "../../src/support/last-error.js";
import { isSecretEnv, makeRedactor, secretEnvValues } from "../../src/support/redact.js";
import {
  collectReport,
  collectSettings,
  describeContents,
  dirSize,
  formatBytes,
  freeSpace,
  type ReportInputs,
  renderReport,
  renderReportJson,
  type StoreSession,
} from "../../src/support/report.js";
import {
  type AttachmentToken,
  bundleErrorMessage,
  listSupportBundles,
  saveSupportBundle,
} from "../../src/support/sdk-bundle.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let dir: string;
beforeEach(() => {
  dir = tmpDataDir("ditto-support-");
});
afterEach(() => rmrf(dir));

const BUNDLE_ROW = {
  _id: { pk: "pk1", created_at: "2026-11-07T12:00:00+00:00" },
  reason: "USER_INITIATED",
  file: { id: "att1", len: 30720, metadata: { source: "test" } },
};
const RATE_ERROR = new Error(
  "Query failed: `Support bundle request failure: failed to request support bundle: support bundle request rate exceeded: at most 3 requests are allowed per 10 minutes; retry in 600 seconds`. For more information on Ditto's query language see: https://ditto.com/link/dql-guide",
);

/** A fake store: answers the support-bundle and summary queries. */
function fakeStore(
  opts: {
    requestFails?: Error;
    existing?: unknown[];
    bundleRow?: unknown;
    collections?: string[];
    countFails?: string;
    summaryFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const saved: { token: AttachmentToken; file: string }[] = [];
  let closed = false;
  const session: StoreSession = {
    async execute(statement: string) {
      calls.push(statement);
      if (statement.startsWith("EXECUTE FUNCTION system_request_support_bundle")) {
        if (opts.requestFails) throw opts.requestFails;
        return { items: [{ value: opts.bundleRow ?? BUNDLE_ROW }] };
      }
      if (statement.startsWith("SELECT * FROM system:support_bundles")) {
        return { items: (opts.existing ?? []).map((value) => ({ value })) };
      }
      if (statement === "SELECT * FROM system:collections") {
        if (opts.summaryFails) throw new Error("summary boom");
        const names = opts.collections ?? ["movies", "__feature_flags", "my `odd` cars"];
        return { items: names.map((name) => ({ value: { name } })) };
      }
      if (statement.startsWith("SELECT COUNT(*)")) {
        if (opts.countFails && statement.includes(opts.countFails)) throw new Error("count boom");
        return { items: [{ value: { n: 42 } }] };
      }
      if (statement === "SELECT * FROM system:indexes") {
        return {
          items: [
            {
              value: {
                _id: "movies.by_year",
                collection: "movies",
                fields: [
                  { key: ["_id", "year"], direction: "asc" },
                  { key: ["rated"], direction: "desc" },
                ],
              },
            },
            { value: { _id: "odd", collection: "c", fields: "weird" } },
          ],
        };
      }
      throw new Error(`unexpected statement: ${statement}`);
    },
    async saveAttachment(token, file) {
      saved.push({ token, file });
      fs.writeFileSync(file, "tar-bytes");
    },
    async close() {
      closed = true;
    },
  };
  return { session, calls, saved, closed: () => closed };
}

describe("makeRedactor", () => {
  it("hides secrets and shows the home folder as ~", () => {
    const r = makeRedactor({
      home: "/Users/al",
      secrets: ["supersecrettoken", undefined, "short"],
    });
    expect(r("token=supersecrettoken in /Users/al/x and /Users/al")).toBe(
      "token=[redacted] in ~/x and ~",
    );
    // A different user whose name starts with the same letters is untouched.
    expect(r("/Users/alex/file")).toBe("/Users/alex/file");
    // Short secrets would mangle ordinary words, so they're skipped.
    expect(r("a short word")).toBe("a short word");
  });

  it("replaces the longer of two overlapping secrets whole", () => {
    const r = makeRedactor({ home: "/", secrets: ["abcdefgh", "abcdefghijkl"] });
    expect(r("x abcdefghijkl y")).toBe("x [redacted] y");
  });

  it("does nothing without secrets or a usable home", () => {
    expect(makeRedactor({ home: "/" })("/a/b")).toBe("/a/b");
    expect(makeRedactor()("plain")).toBe("plain");
  });
});

describe("credential env vars", () => {
  it("recognizes credentials by list and by name", () => {
    for (const k of [
      "DITTOSH_GITHUB_TOKEN",
      "OFFLINE_TOKEN",
      "DATABASE_ID",
      "DITTOSH_SOME_SECRET",
      "MY_API_KEY",
      "DITTOSH_PASSWORD",
    ]) {
      expect(isSecretEnv(k), k).toBe(true);
    }
    for (const k of ["DITTOSH_DATA_DIR", "DITTOSH_QUIET", "TERM", "PAGER"]) {
      expect(isSecretEnv(k), k).toBe(false);
    }
  });

  it("collects the values of set credential vars only", () => {
    expect(
      secretEnvValues({ DITTOSH_GITHUB_TOKEN: "ghp_x", OTHER: "y", EMPTY_TOKEN: "" }).sort(),
    ).toEqual(["ghp_x"]);
  });
});

describe("last error", () => {
  it("keeps the last lines written to a stream, without colors, and passes writes through", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    const seen: string[] = [];
    (stream as unknown as PassThrough).on("data", (d) => seen.push(String(d)));
    const tail = startStderrTail(stream, 3);
    stream.write("\x1b[31mone\x1b[39m\ntwo\n");
    stream.write(Buffer.from("three\nfour\npar"));
    stream.write("tial");
    stream.write(new Uint8Array([1]) as unknown as string); // not a string or Buffer: ignored by capture
    expect(tail.lines()).toEqual(["three", "four", "partial"]);
    tail.stop();
    stream.write("after\n");
    expect(tail.lines()).toEqual(["three", "four", "partial"]);
    expect(seen.join("")).toContain("one");
    expect(seen.join("")).toContain("after");
  });

  it("records and reads the last error", () => {
    const entry: LastError = {
      time: "2026-11-07T00:00:00Z",
      version: "0.2.0",
      command: ["dql", "SELEC"],
      exitCode: 1,
      stderr: ["Query error"],
      stack: "Error: x\n  at y",
    };
    recordLastError(entry, dir);
    expect(readLastError(dir)).toEqual(entry);
    // Without a stack, the field is left out.
    recordLastError({ ...entry, stack: undefined }, dir);
    expect(readLastError(dir)).not.toHaveProperty("stack");
  });

  it("returns null for a missing, corrupt, or wrong-shaped file, and fills defaults", () => {
    expect(readLastError(dir)).toBeNull();
    const f = path.join(dir, LAST_ERROR_FILE);
    fs.writeFileSync(f, "{not json");
    expect(readLastError(dir)).toBeNull();
    fs.writeFileSync(f, "[1]");
    expect(readLastError(dir)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ time: 5, command: [] }));
    expect(readLastError(dir)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ time: "t", command: ["a", 1] }));
    expect(readLastError(dir)).toEqual({
      time: "t",
      version: "unknown",
      command: ["a", "1"],
      exitCode: 1,
      stderr: [],
    });
  });

  it("never throws when the config dir can't be written", () => {
    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "x");
    expect(() =>
      recordLastError(
        { time: "t", version: "v", command: [], exitCode: 1, stderr: [] },
        path.join(file, "sub"),
      ),
    ).not.toThrow();
  });

  it("knows which commands are diagnostics", () => {
    expect(isDiagnosticCommand(["doctor", "--report"])).toBe(true);
    expect(isDiagnosticCommand(["dql", "support-bundle"])).toBe(true);
    expect(isDiagnosticCommand(["dql", "SELECT 1"])).toBe(false);
  });
});

describe("sdkDebugLevel", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["0", null],
    ["false", null],
    ["off", null],
    ["1", "Debug"],
    ["true", "Debug"],
    ["VERBOSE", "Verbose"],
  ])("%s → %s", (value, level) => {
    expect(sdkDebugLevel(value)).toBe(level);
  });
});

describe("SDK support bundle", () => {
  it("requests a bundle with metadata and saves its attachment", async () => {
    const f = fakeStore();
    const out = path.join(dir, "b.tar");
    const saved = await saveSupportBundle(f.session, out, { source: "dittosh 'x'", v: "1.0" });
    expect(f.calls[0]).toBe(
      "EXECUTE FUNCTION system_request_support_bundle({'metadata': {'source': 'dittosh x', 'v': '1.0'}})",
    );
    expect(f.saved[0]).toEqual({ token: BUNDLE_ROW.file, file: out });
    expect(saved).toEqual({
      path: out,
      bytes: 30720,
      createdAt: "2026-11-07T12:00:00+00:00",
      reason: "USER_INITIATED",
    });
  });

  it("saves the newest existing bundle when a new one is refused", async () => {
    const f = fakeStore({ requestFails: RATE_ERROR, existing: [BUNDLE_ROW] });
    const saved = await saveSupportBundle(f.session, path.join(dir, "b.tar"));
    expect(saved.reusedBecause).toBe(
      "support bundle request rate exceeded: at most 3 requests are allowed per 10 minutes; retry in 600 seconds",
    );
    expect(f.calls[1]).toContain("ORDER BY _id.created_at DESC LIMIT 1");
  });

  it("throws the refusal when there's no bundle to fall back on", async () => {
    const f = fakeStore({ requestFails: RATE_ERROR });
    await expect(saveSupportBundle(f.session, path.join(dir, "b.tar"))).rejects.toThrow(
      /rate exceeded/,
    );
  });

  it("throws when the SDK returns no file, and defaults missing fields", async () => {
    await expect(
      saveSupportBundle(fakeStore({ bundleRow: {} }).session, path.join(dir, "b.tar")),
    ).rejects.toThrow(/no support bundle file/);
    const saved = await saveSupportBundle(
      fakeStore({ bundleRow: { file: { id: "a", len: 5n, metadata: {} } } }).session,
      path.join(dir, "c.tar"),
    );
    expect(saved).toMatchObject({ bytes: 5, createdAt: "unknown", reason: "unknown" });
  });

  it("lists bundles newest first", async () => {
    const f = fakeStore({ existing: [BUNDLE_ROW, {}] });
    expect(await listSupportBundles(f.session)).toEqual([
      { created_at: "2026-11-07T12:00:00+00:00", reason: "USER_INITIATED", bytes: 30720 },
      { created_at: "unknown", reason: "unknown", bytes: 0 },
    ]);
  });

  it("strips the SDK's error wrapper", () => {
    expect(bundleErrorMessage(RATE_ERROR)).toMatch(/^support bundle request rate exceeded/);
    expect(bundleErrorMessage("plain")).toBe("plain");
  });
});

describe("report helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(3 * 1024 ** 5)).toBe("3072 TB");
  });

  it("sizes a directory tree and finds free space for a missing path", () => {
    fs.mkdirSync(path.join(dir, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a/b/f"), "12345");
    fs.writeFileSync(path.join(dir, "g"), "123");
    expect(dirSize(dir)).toBe(8);
    expect(dirSize(path.join(dir, "missing"))).toBe(0);
    expect(freeSpace(path.join(dir, "not/yet/here"))).toBeGreaterThan(0);
  });

  it("lists settings and hides credential values", () => {
    const s = collectSettings({
      DITTOSH_DATA_DIR: "/d",
      NO_COLOR: "",
      OFFLINE_TOKEN: "secret-token",
      PATH: "/bin",
    });
    expect(s.DITTOSH_DATA_DIR).toBe("/d");
    expect(s.NO_COLOR).toBe("");
    expect(s.OFFLINE_TOKEN).toBe("set (value hidden)");
    expect(s.DATABASE_ID).toBe("not set");
    expect(s).not.toHaveProperty("PATH");
    expect(JSON.stringify(s)).not.toContain("secret-token");
    const t = collectSettings({
      DITTOSH_GITHUB_TOKEN: "ghp_FAKEtoken1234567890",
      DITTOSH_FUTURE_SECRET: "another-secret-value",
    });
    expect(t.DITTOSH_GITHUB_TOKEN).toBe("set (value hidden)");
    expect(t.DITTOSH_FUTURE_SECRET).toBe("set (value hidden)");
    expect(JSON.stringify(t)).not.toMatch(/ghp_FAKE|another-secret/);
  });
});

describe("collectReport", () => {
  const checks: DoctorCheck[] = [
    { ok: true, label: "platform", detail: "darwin/arm64 supported" },
    { ok: false, label: "lock", detail: "locked" },
  ];
  const lastError: LastError = {
    time: "2026-11-07T00:00:00Z",
    version: "0.2.0",
    command: ["dql", "SELEC x"],
    exitCode: 1,
    stderr: ["Query error"],
    stack: "Error: boom\n  at here",
  };

  function inputs(over: Partial<ReportInputs> = {}): ReportInputs {
    const f = fakeStore();
    return {
      dataDir: path.join(dir, "store"),
      configDir: path.join(dir, "cfg"),
      includeStore: true,
      includeSdkBundle: true,
      workDir: dir,
      checks,
      environment: { dittosh: "0.2.0" },
      lastError: null,
      env: {},
      openStore: async () => f.session,
      saveBundle: (s, file) => saveSupportBundle(s, file),
      now: () => new Date("2026-11-07T10:00:00Z"),
      ...over,
    };
  }

  function makeStoreDir() {
    fs.mkdirSync(path.join(dir, "store"), { recursive: true });
    fs.writeFileSync(path.join(dir, "store", "__ditto_lock_file"), "");
    fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cfg", "state.json"), "{}");
  }

  it("summarizes the store, saves the SDK bundle, and closes the store", async () => {
    makeStoreDir();
    const f = fakeStore({ countFails: "odd" });
    const r = await collectReport(inputs({ openStore: async () => f.session, lastError }));
    expect(r.generated).toBe("2026-11-07T10:00:00.000Z");
    expect(r.environment.dittosh).toBe("0.2.0");
    expect(r.environment.platform).toBe(`${process.platform}/${process.arch}`);
    expect(r.paths["config files"]).toBe("state.json");
    expect(r.store.collections).toEqual([
      { name: "movies", documents: 42 },
      { name: "my `odd` cars", documents: "count failed: count boom" },
    ]);
    // Backticks in a collection name are doubled inside the quoted identifier.
    expect(f.calls).toContain("SELECT COUNT(*) AS n FROM `my ``odd`` cars`");
    expect(r.store.indexes).toEqual([
      { id: "movies.by_year", collection: "movies", fields: "_id.year, rated desc" },
      { id: "odd", collection: "c", fields: "" },
    ]);
    expect(r.sdkBundle).toEqual({
      file: "ditto-support-bundle.tar",
      detail: "30 KB, created 2026-11-07T12:00:00+00:00",
    });
    expect(fs.existsSync(path.join(dir, "ditto-support-bundle.tar"))).toBe(true);
    expect(f.closed()).toBe(true);

    const md = renderReport(r);
    expect(md).toContain("# dittosh diagnostic report");
    expect(md).toContain("- ✓ **platform**: darwin/arm64 supported");
    expect(md).toContain("- ✗ **lock**: locked");
    expect(md).toContain("| movies | 42 |");
    expect(md).toContain("| movies.by_year | movies | _id.year, rated desc |");
    expect(md).toContain("`ditto-support-bundle.tar`: 30 KB");
    expect(md).toContain("`dittosh dql SELEC x` exited 1");
    expect(md).toContain("Error: boom");
    const contents = describeContents(r).join("\n");
    expect(contents).toContain("store summary");
    expect(contents).toContain("last error");
    expect(contents).toContain("ditto-support-bundle.tar");
  });

  it("explains a reused SDK bundle", async () => {
    makeStoreDir();
    const f = fakeStore({ requestFails: RATE_ERROR, existing: [BUNDLE_ROW] });
    const r = await collectReport(inputs({ openStore: async () => f.session }));
    expect(r.sdkBundle.detail).toContain("an existing bundle");
  });

  it("reports when there's no store yet, without opening one", async () => {
    let opened = false;
    const r = await collectReport(
      inputs({
        openStore: async () => {
          opened = true;
          throw new Error("should not open");
        },
      }),
    );
    expect(opened).toBe(false);
    expect(r.paths["store size"]).toBe("no store yet");
    expect(r.paths["config files"]).toBe("(none)");
    expect(r.store.skipped).toBe("no store at the data directory yet");
    expect(r.sdkBundle.detail).toContain("not created");
    const md = renderReport(r);
    expect(md).toContain("Not included: no store at the data directory yet.");
    expect(md).toContain("No failed command recorded.");
    expect(describeContents(r)).toHaveLength(1);
  });

  it("respects --no-store and --no-sdk-bundle", async () => {
    makeStoreDir();
    const r = await collectReport(inputs({ includeStore: false, includeSdkBundle: false }));
    expect(r.store.skipped).toBe("left out (--no-store)");
    expect(r.sdkBundle.detail).toBe("left out (--no-sdk-bundle)");
    // No store yet either: the opt-out text still wins for skipped parts.
    rmrf(path.join(dir, "store"));
    const r2 = await collectReport(inputs({ includeStore: false, includeSdkBundle: false }));
    expect(r2.store.skipped).toBe("left out (--no-store)");
  });

  it("records a store that won't open", async () => {
    makeStoreDir();
    const r = await collectReport(
      inputs({
        openStore: async () => {
          throw new Error("locked by another process\nmore detail");
        },
      }),
    );
    expect(r.store.skipped).toBe("the store didn't open: locked by another process");
    expect(r.sdkBundle.detail).toBe(
      "not created: the store didn't open: locked by another process",
    );
  });

  it("records summary and bundle failures and still closes the store", async () => {
    makeStoreDir();
    const f = fakeStore({ summaryFails: true, requestFails: new Error("boom") });
    const r = await collectReport(inputs({ openStore: async () => f.session }));
    expect(r.store.skipped).toBe("summary failed: summary boom");
    expect(r.sdkBundle.detail).toBe("failed: boom");
    expect(f.closed()).toBe(true);
  });

  it("keeps table cells intact with pipes, backslashes, and newlines", async () => {
    const r = await collectReport(
      inputs({ environment: { path: "C:\\Users\\x\\|y", note: "a|b\nc" } }),
    );
    const md = renderReport(r);
    expect(md).toContain("| path | C:\\Users\\x\\&#124;y |");
    expect(md).toContain("| note | a&#124;b c |");
  });

  it("renders empty stores and a last error without output", async () => {
    makeStoreDir();
    const f = fakeStore({ collections: [] });
    f.session.execute = async () => ({ items: [] });
    const r = await collectReport(
      inputs({
        openStore: async () => f.session,
        includeSdkBundle: false,
        lastError: { ...lastError, stderr: [], stack: undefined },
      }),
    );
    const md = renderReport(r);
    expect(md).toContain("No collections.");
    expect(md).toContain("No indexes.");
    expect(md).toContain("left out (--no-sdk-bundle)");
    expect(md).not.toContain("Stack trace");
  });
});

describe("renderReportJson", () => {
  it("redacts Windows home paths and secrets that JSON would escape", () => {
    const redact = makeRedactor({ home: "C:\\Users\\al", secrets: ['tok"en\\secret'] });
    const report = {
      generated: "t",
      environment: { node: "C:\\Users\\al\\node.exe", note: 'value tok"en\\secret here' },
      checks: [],
      settings: {},
      paths: { "data directory": "C:\\Users\\al\\AppData\\Local\\dittosh" },
      store: {},
      sdkBundle: { detail: "" },
      lastError: null,
    };
    const json = renderReportJson(report, redact);
    expect(json).not.toContain("Users");
    expect(json).not.toContain("secret");
    const parsed = JSON.parse(json);
    expect(parsed.paths["data directory"]).toBe("~\\AppData\\Local\\dittosh");
    expect(parsed.environment.note).toBe("value [redacted] here");
  });
});

describe("writeArchive", () => {
  it("puts the files under one folder in a .tar.gz", async () => {
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "report.md"), "# hi");
    fs.writeFileSync(path.join(work, "report.json"), "{}");
    const out = path.join(dir, "out", "r.tar.gz");
    const size = await writeArchive(out, work, "r", ["report.md", "report.json"]);
    expect(size).toBe(fs.statSync(out).size);
    const entries: string[] = [];
    await tar.t({ file: out, onReadEntry: (e) => entries.push(e.path) });
    expect(entries.sort()).toEqual(["r/", "r/report.json", "r/report.md"]);
  });

  it("works when the folder name matches a staged file (--report report.md)", async () => {
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, "report.md"), "# hi");
    fs.writeFileSync(path.join(work, "report.json"), "{}");
    const out = path.join(dir, "report.md");
    await writeArchive(out, work, "report.md", ["report.md", "report.json"]);
    const entries: string[] = [];
    await tar.t({ file: out, onReadEntry: (e) => entries.push(e.path) });
    expect(entries.sort()).toEqual(["report.md/", "report.md/report.json", "report.md/report.md"]);
  });
});
