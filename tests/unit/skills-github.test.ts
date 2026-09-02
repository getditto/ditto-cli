import { describe, expect, it, vi } from "vitest";
import { fetchTarball, resolveRef, SkillsFetchError } from "../../src/skills/github.js";

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(8),
    body: new ReadableStream(),
  } as unknown as Response;
}

describe("skills/github", () => {
  it("resolves the latest release tag", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, { tag_name: "v1.2.3" }));
    expect(await resolveRef(fetchFn as never)).toBe("v1.2.3");
  });

  it("falls back to main when there are no releases (404)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(404, {}));
    expect(await resolveRef(fetchFn as never)).toBe("main");
  });

  it("401/403 → actionable private-repo guidance", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    await expect(resolveRef(fetchFn as never)).rejects.toSatisfy(
      (e) =>
        e instanceof SkillsFetchError && e.message.includes("GITHUB_TOKEN") && e.exitCode === 1,
    );
  });

  it("other HTTP errors surface the status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(502, {}));
    await expect(resolveRef(fetchFn as never)).rejects.toThrow("GitHub API error 502");
  });

  it("release without a tag_name falls back to main", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, {}));
    expect(await resolveRef(fetchFn as never)).toBe("main");
  });

  it("sends auth headers when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "tok123";
    try {
      const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, { tag_name: "v1" }));
      await resolveRef(fetchFn as never);
      const headers = (fetchFn.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer tok123");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("fetchTarball errors with guidance on 404/401", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(404, {}));
    await expect(fetchTarball("main", fetchFn as never)).rejects.toThrow(SkillsFetchError);
  });

  it("fetchTarball returns bytes on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, {}));
    const buf = await fetchTarball("v1", fetchFn as never);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });
});
