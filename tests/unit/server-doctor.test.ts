import { describe, expect, it } from "vitest";
import { collectServerDoctorChecks } from "../../src/cli/groups/server/doctor.js";
import type { FetchLike } from "../../src/server/client.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/** Doctor checks with an injected fetch — no network, no env leakage. */

function fetchReply(status: number, body: unknown): FetchLike {
  return async () => ({
    status,
    statusText: "",
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  });
}

const FETCH_FAILS: FetchLike = async () => {
  throw new Error("ENOTFOUND");
};

const EXECUTE_OK = fetchReply(200, {
  transactionId: 123,
  queryType: "select",
  items: [1],
  mutatedDocumentIds: [],
});

const ENV = { DITTOSH_SERVER_URL: "x.example/app", DITTOSH_SERVER_API_KEY: "key" };

function emptyCwd(): string {
  return tmpDataDir("dittosh-doctor-");
}

describe("server doctor", () => {
  it("all green: config (with sources), connection, auth", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        env: ENV,
        cwd,
        fetchImpl: EXECUTE_OK,
      });
      expect(checks.map((c) => c.label)).toEqual(["config", "connection", "auth"]);
      expect(checks.every((c) => c.ok)).toBe(true);
      expect(checks[0]!.detail).toContain("https://x.example/app");
      expect(checks[0]!.detail).toContain("shell env");
      expect(checks[2]!.detail).toContain("transactionId 123");
      // The key value must never appear in any check detail.
      expect(JSON.stringify(checks)).not.toContain('"key"');
    } finally {
      rmrf(cwd);
    }
  });

  it("flags are reported as the source", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        url: "flag.example/app",
        apiKey: "flag-key",
        env: {},
        cwd,
        fetchImpl: EXECUTE_OK,
      });
      expect(checks[0]!.detail).toContain("(flag)");
    } finally {
      rmrf(cwd);
    }
  });

  it("missing config → config fails, connection/auth skipped", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({ env: {}, cwd, fetchImpl: EXECUTE_OK });
      expect(checks[0]).toMatchObject({ ok: false, label: "config" });
      expect(checks[0]!.detail).toContain("DITTOSH_SERVER_URL");
      expect(checks[1]!.detail).toContain("skipped");
      expect(checks[2]!.detail).toContain("skipped");
    } finally {
      rmrf(cwd);
    }
  });

  it("unreachable server → connection fails, auth skipped", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        env: ENV,
        cwd,
        fetchImpl: FETCH_FAILS,
      });
      expect(checks[0]!.ok).toBe(true);
      expect(checks[1]).toMatchObject({ ok: false, label: "connection" });
      expect(checks[1]!.detail).toContain("Cannot reach");
      expect(checks[2]!.detail).toContain("skipped");
    } finally {
      rmrf(cwd);
    }
  });

  it("401 → connection ok, auth fails with portal guidance", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        env: ENV,
        cwd,
        fetchImpl: fetchReply(401, { message: "invalid API key" }),
      });
      expect(checks[1]!.ok).toBe(true);
      expect(checks[2]).toMatchObject({ ok: false, label: "auth" });
      expect(checks[2]!.detail).toContain("invalid API key");
      expect(checks[2]!.detail).toContain("Auth");
    } finally {
      rmrf(cwd);
    }
  });

  it("500 → connection ok, auth reports the HTTP status", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        env: ENV,
        cwd,
        fetchImpl: fetchReply(500, { message: "boom" }),
      });
      expect(checks[1]!.ok).toBe(true);
      expect(checks[2]!.ok).toBe(false);
      expect(checks[2]!.detail).toContain("HTTP 500");
    } finally {
      rmrf(cwd);
    }
  });

  it("200 with a DQL error body → key was accepted; note in the detail", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        env: ENV,
        cwd,
        fetchImpl: fetchReply(200, { queryType: "unknown", error: { description: "odd" } }),
      });
      expect(checks[2]!.ok).toBe(true);
      expect(checks[2]!.detail).toContain("odd");
    } finally {
      rmrf(cwd);
    }
  });

  it("400 → key was accepted (auth happens before query parsing)", async () => {
    const cwd = emptyCwd();
    try {
      const checks = await collectServerDoctorChecks({
        env: ENV,
        cwd,
        fetchImpl: fetchReply(400, { message: "Invalid query" }),
      });
      expect(checks[2]!.ok).toBe(true);
      expect(checks[2]!.detail).toContain("API key accepted");
    } finally {
      rmrf(cwd);
    }
  });

  it("honors --api-version for the probe", async () => {
    const cwd = emptyCwd();
    let seenUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      seenUrl = url;
      return {
        status: 200,
        statusText: "",
        headers: { get: () => null },
        text: async () => JSON.stringify({ transactionId: 1, queryType: "select", items: [] }),
      };
    };
    try {
      await collectServerDoctorChecks({ env: ENV, cwd, apiVersion: "v4", fetchImpl });
      expect(seenUrl).toContain("/api/v4/store/execute");
    } finally {
      rmrf(cwd);
    }
  });
});

describe("regression: fail-closed probe (round 3 agreed major)", () => {
  it("a 200 non-DQL body (proxy/SSO page) → auth NOT green", async () => {
    const cwd = emptyCwd();
    try {
      const fetchImpl: FetchLike = async () => ({
        status: 200,
        statusText: "",
        headers: { get: () => "text/html" },
        text: async () => "<html>login</html>",
      });
      const checks = await collectServerDoctorChecks({ env: ENV, cwd, fetchImpl });
      expect(checks[1]!.ok).toBe(true); // connection — something answered
      expect(checks[2]!.ok).toBe(false); // auth must NOT claim success
      expect(checks[2]!.detail).toContain("Invalid response from Ditto Server");
    } finally {
      rmrf(cwd);
    }
  });

  it("a probe timeout → connection ✗, auth skipped", async () => {
    const cwd = emptyCwd();
    try {
      const fetchImpl: FetchLike = async () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      };
      const checks = await collectServerDoctorChecks({ env: ENV, cwd, fetchImpl });
      expect(checks[1]).toMatchObject({ ok: false, label: "connection" });
      expect(checks[1]!.detail).toContain("may still be running");
      expect(checks[2]!.detail).toContain("skipped");
    } finally {
      rmrf(cwd);
    }
  });
});
