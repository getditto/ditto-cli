import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runStatement } from "../../src/cli/groups/dql/run.js";
import { DittoSession } from "../../src/ditto/session.js";
import { loadIdentity } from "../../src/identity/token.js";
import { hasDevCredentials, NO_CREDENTIALS, rmrf, tmpDataDir } from "../helpers/credentials.js";

describe.skipIf(!hasDevCredentials)(`integration: diagnostics (${NO_CREDENTIALS})`, () => {
  let dataDir: string;
  let session: DittoSession;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    dataDir = tmpDataDir("ditto-diag-");
    session = await DittoSession.open(loadIdentity(), dataDir);
    await session.execute(
      "INSERT INTO movies DOCUMENTS ({'_id':'d1','title':'Alien','year':1979,'rated':'R'}), ({'_id':'d2','title':'Toy Story','year':1995,'rated':'G'}) ON ID CONFLICT DO UPDATE",
    );
  });

  beforeEach(() => {
    outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  afterAll(async () => {
    await session?.close();
    rmrf(dataDir);
  });

  it("--profile returns a parsed envelope with a real plan tree", async () => {
    const r = await runStatement(session, "SELECT * FROM movies WHERE rated = 'R'", {
      maxRows: 10_000,
      maxRowsExplicit: false,
      format: "json",
      profile: true,
    });
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(1);
    expect(r.profile?.plan?.children.length).toBeGreaterThan(0);
    expect(r.profile?.times.elapsedNs).toBeGreaterThan(0);
    const out = outSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Execution Profile");
    expect(out).toContain("filter");
  });

  it("--explain side-trip returns the plan document", async () => {
    const r = await runStatement(session, "SELECT * FROM movies WHERE rated = 'G'", {
      maxRows: 10_000,
      maxRowsExplicit: false,
      format: "json",
      explain: true,
    });
    expect(r.ok).toBe(true);
    const out = outSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Query plan");
    expect(out).toContain("scan");
  });

  it("--time footer includes server-side times when profiling", async () => {
    await runStatement(session, "SELECT * FROM movies", {
      maxRows: 10_000,
      maxRowsExplicit: false,
      format: "json",
      time: true,
      profile: true,
    });
    const err = errSpy.mock.calls.flat().join("\n");
    expect(err).toMatch(/Time: [\d.]+ ms — server: elapsed/);
  });
});
