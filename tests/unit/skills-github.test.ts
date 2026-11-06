import { describe, expect, it, vi } from "vitest";
import {
  fetchTarball,
  listReleases,
  resolveRef,
  SkillsFetchError,
} from "../../src/skills/github.js";

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

  it("prefers the slim release asset, fetched via the API with octet-stream", async () => {
    const assetUrl = "https://api.github.com/repos/getditto/agent-skills/releases/assets/42";
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/releases/tags/")) {
        return fakeResponse(200, { assets: [{ name: "ditto-skills.tar.gz", url: assetUrl }] });
      }
      return fakeResponse(200, {});
    });
    const buf = await fetchTarball("v1.0.0", fetchFn as never);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2); // release lookup + asset download, never codeload
    const [url, init] = fetchFn.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(url).toBe(assetUrl);
    expect(init.headers.Accept).toBe("application/octet-stream");
  });

  it("falls back to codeload when the release has no slim asset", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/releases/tags/")) return fakeResponse(200, { assets: [] });
      return fakeResponse(200, {}); // codeload
    });
    const buf = await fetchTarball("v0.0.1", fetchFn as never);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(fetchFn.mock.calls[1]![0]).toContain("codeload.github.com");
  });

  it("falls back to codeload when there is no release for the ref (404)", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/releases/tags/")) return fakeResponse(404, {});
      return fakeResponse(200, {}); // codeload
    });
    const buf = await fetchTarball("main", fetchFn as never);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(fetchFn.mock.calls[1]![0]).toContain("codeload.github.com");
  });

  it("asset download auth failure → private-repo guidance", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/releases/tags/")) {
        return fakeResponse(200, {
          assets: [{ name: "ditto-skills.tar.gz", url: "https://asset" }],
        });
      }
      return fakeResponse(401, {});
    });
    await expect(fetchTarball("v1.0.0", fetchFn as never)).rejects.toSatisfy(
      (e) => e instanceof SkillsFetchError && e.message.includes("GITHUB_TOKEN"),
    );
  });

  it("release lookup auth failure → private-repo guidance", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(403, {}));
    await expect(fetchTarball("v1.0.0", fetchFn as never)).rejects.toThrow(SkillsFetchError);
  });
});

describe("listReleases", () => {
  it("maps releases newest-first with asset detection", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse(200, [
        {
          tag_name: "v1.1.0",
          name: "Release v1.1.0",
          published_at: "2026-11-01T00:00:00Z",
          assets: [{ name: "ditto-skills.tar.gz" }],
        },
        { tag_name: "v1.0.0", name: "", published_at: "2026-10-01T00:00:00Z", assets: [] },
      ]),
    );
    const rels = await listReleases(fetchFn as never);
    expect(rels).toEqual([
      {
        tag: "v1.1.0",
        name: "Release v1.1.0",
        publishedAt: "2026-11-01T00:00:00Z",
        hasAsset: true,
      },
      { tag: "v1.0.0", name: "", publishedAt: "2026-10-01T00:00:00Z", hasAsset: false },
    ]);
  });

  it("404 → empty list (repo has no releases)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(404, {}));
    expect(await listReleases(fetchFn as never)).toEqual([]);
  });

  it("401/403 → private-repo guidance", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    await expect(listReleases(fetchFn as never)).rejects.toThrow(SkillsFetchError);
  });

  it("other HTTP errors surface the status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(502, {}));
    await expect(listReleases(fetchFn as never)).rejects.toThrow("502");
  });
});
