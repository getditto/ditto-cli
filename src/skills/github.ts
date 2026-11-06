import fs from "node:fs";

/**
 * GitHub fetch layer for agent skills. Source repo: getditto/agent-skills.
 * `GITHUB_TOKEN` (or `DITTOSH_GITHUB_TOKEN`) authenticates while the repo is
 * private; on 401/404 we produce actionable guidance.
 *
 * Test seam: `DITTOSH_SKILLS_TARBALL=/path/to/repo.tar.gz` bypasses the network
 * entirely (resolveRef → "fixture", fetchTarball reads the file from disk).
 */

const REPO = "getditto/agent-skills";
const API = "https://api.github.com";
const CODELoad = "https://codeload.github.com";

/** The slim skills-only archive attached to each release by the upstream Release workflow. */
export const SKILLS_ASSET = "ditto-skills.tar.gz";

export class SkillsFetchError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "SkillsFetchError";
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "dittosh",
    Accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.DITTOSH_GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const PRIVATE_GUIDANCE =
  `The ${REPO} repo is private (or unreachable). Until it goes public, set GITHUB_TOKEN ` +
  `to a token with access, e.g.:  GITHUB_TOKEN=$(gh auth token) dittosh skills add …`;

/** Resolve the ref to fetch: latest release tag, falling back to `main`. */
export async function resolveRef(fetchFn: typeof fetch = fetch): Promise<string> {
  if (process.env.DITTOSH_SKILLS_TARBALL) return "fixture"; // test seam
  const res = await fetchFn(`${API}/repos/${REPO}/releases/latest`, { headers: headers() });
  if (res.status === 404) {
    // No releases yet (or private without a token) — fall back to main.
    return "main";
  }
  if (res.status === 401 || res.status === 403) {
    throw new SkillsFetchError(PRIVATE_GUIDANCE);
  }
  if (!res.ok) {
    throw new SkillsFetchError(`GitHub API error ${res.status} resolving the latest release.`);
  }
  const body = (await res.json()) as { tag_name?: string };
  return body.tag_name ?? "main";
}

/** A published skills release, as shown by `skills versions`. */
export interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  /** Whether the release carries the slim SKILLS_ASSET archive. */
  hasAsset: boolean;
}

/** List published releases (newest first). Empty when the repo has none (or on 404). */
export async function listReleases(fetchFn: typeof fetch = fetch): Promise<ReleaseInfo[]> {
  if (process.env.DITTOSH_SKILLS_TARBALL) return []; // test seam: fixture mode has no releases
  const res = await fetchFn(`${API}/repos/${REPO}/releases?per_page=20`, {
    headers: headers(),
  });
  if (res.status === 404) return [];
  if (res.status === 401 || res.status === 403) {
    throw new SkillsFetchError(PRIVATE_GUIDANCE);
  }
  if (!res.ok) {
    throw new SkillsFetchError(`GitHub API error ${res.status} listing releases.`);
  }
  const body = (await res.json()) as {
    tag_name?: string;
    name?: string;
    published_at?: string;
    assets?: { name?: string }[];
  }[];
  return body.map((r) => ({
    tag: r.tag_name ?? "unknown",
    name: r.name ?? "",
    publishedAt: r.published_at ?? "",
    hasAsset: (r.assets ?? []).some((a) => a.name === SKILLS_ASSET),
  }));
}

/**
 * Download the skills archive for a ref. Returns the raw gzipped bytes.
 *
 * Asset-first: for tagged releases published by the upstream Release workflow we
 * fetch the slim skills-only asset (~10x smaller than the repo and flat as the
 * repo's test suites grow). Refs without a release asset (e.g. `main`, or tags
 * predating the workflow) fall back to the full-repo codeload tarball.
 */
export async function fetchTarball(ref: string, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  const seam = process.env.DITTOSH_SKILLS_TARBALL;
  if (seam) {
    try {
      return fs.readFileSync(seam);
    } catch (err) {
      throw new SkillsFetchError(
        `DITTOSH_SKILLS_TARBALL unreadable: ${seam} (${(err as Error).message})`,
      );
    }
  }

  const rel = await fetchFn(`${API}/repos/${REPO}/releases/tags/${encodeURIComponent(ref)}`, {
    headers: headers(),
  });
  if (rel.ok) {
    const body = (await rel.json()) as { assets?: { name?: string; url?: string }[] };
    const asset = body.assets?.find((a) => a.name === SKILLS_ASSET);
    if (asset?.url) {
      // Private repo: asset downloads must go through the API URL with an
      // octet-stream Accept (browser_download_url won't authenticate).
      const dl = await fetchFn(asset.url, {
        headers: { ...headers(), Accept: "application/octet-stream" },
        redirect: "follow",
      });
      if (dl.status === 401 || dl.status === 403 || dl.status === 404) {
        throw new SkillsFetchError(PRIVATE_GUIDANCE);
      }
      if (!dl.ok || !dl.body) {
        throw new SkillsFetchError(`GitHub asset download failed: HTTP ${dl.status}`);
      }
      return Buffer.from(await dl.arrayBuffer());
    }
    // Release without the slim asset (predates the workflow) → codeload fallback.
  } else if (rel.status === 401 || rel.status === 403) {
    throw new SkillsFetchError(PRIVATE_GUIDANCE);
  }
  // 404 (no release for this ref — e.g. `main`) → codeload fallback.

  const res = await fetchFn(`${CODELoad}/${REPO}/tar.gz/${encodeURIComponent(ref)}`, {
    headers: headers(),
    redirect: "follow",
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new SkillsFetchError(PRIVATE_GUIDANCE);
  }
  if (!res.ok || !res.body) {
    throw new SkillsFetchError(`GitHub tarball download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
