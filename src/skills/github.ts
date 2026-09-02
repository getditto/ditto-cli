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

/** Download the repo tarball for a ref. Returns the raw gzipped bytes. */
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
