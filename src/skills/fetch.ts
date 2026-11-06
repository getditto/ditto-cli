import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { SkillsFetchError } from "./github.js";

/**
 * Extract `skills/<name>/` directories from an upstream archive into a fresh
 * staging dir.
 *
 * Two archive layouts are supported:
 * - codeload tarballs carry a `<owner>-<repo>-<sha>/` root prefix
 * - release assets (built by the agent-skills Release workflow) have `skills/`
 *   at the archive root
 *
 * Only regular files/dirs are extracted (symlinks and other entry types are
 * dropped — we install copies, never links, per the Windows-safe design).
 * Returned paths live at <staging>/<name> and share one parent, so a single
 * `cleanupStaging` call on any of them removes the whole staging tree.
 */

/** Matches both layouts; captures the skill name and the path within the skill. */
const SKILL_PATH = /^(?:[^/]+\/)?skills\/([^/]+)\/(.+)$/;

function isJunk(p: string): boolean {
  const base = path.posix.basename(p);
  return base.startsWith("._") || base === ".DS_Store"; // macOS metadata junk
}

/** Write the tarball bytes into a fresh staging dir. Caller cleans up. */
function stageTarball(tarball: Buffer): { staging: string; tgz: string } {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-skill-"));
  const tgz = path.join(staging, "repo.tar.gz");
  fs.writeFileSync(tgz, tarball);
  return { staging, tgz };
}

/** List the skills an archive ships (dirs under skills/ that contain a SKILL.md). */
export async function listSkills(tarball: Buffer): Promise<string[]> {
  const { staging, tgz } = stageTarball(tarball);
  try {
    const names = new Set<string>();
    await tar.t({
      file: tgz,
      onentry: (entry) => {
        const m = entry.path.match(SKILL_PATH);
        if (m && m[2] === "SKILL.md") names.add(m[1]!);
      },
    });
    return [...names].sort();
  } catch (err) {
    throw new SkillsFetchError(`failed to read the skills archive: ${(err as Error).message}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Extract several skills in one pass. Returns skill name → staged directory
 * (skill files at its root). Throws SkillsFetchError if a requested skill is
 * absent, naming what the archive does ship.
 */
export async function extractSkills(
  tarball: Buffer,
  names: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(names);
  const { staging, tgz } = stageTarball(tarball);
  const raw = path.join(staging, "raw");
  try {
    fs.mkdirSync(raw, { recursive: true });
    await tar.x({
      file: tgz,
      cwd: raw,
      filter: (p, entry) => {
        const entryType = "type" in entry ? entry.type : "File";
        if (entryType !== "File" && entryType !== "Directory") return false; // no symlinks/links/devices
        if (isJunk(p)) return false;
        const m = p.match(SKILL_PATH);
        return m !== null && wanted.has(m[1]!);
      },
    });

    // Locate the skills/ root inside the raw extraction: either directly
    // (release asset) or under the single codeload root directory.
    let skillsRoot = path.join(raw, "skills");
    if (!fs.existsSync(skillsRoot)) {
      const children = fs.readdirSync(raw, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (children.length === 1) {
        skillsRoot = path.join(raw, children[0]!.name, "skills");
      }
    }

    const out = new Map<string, string>();
    for (const name of names) {
      const srcDir = path.join(skillsRoot, name);
      if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
        // Only wanted skills were extracted, so enumerate the archive for the
        // error message (error path only — one extra read pass).
        let available: string[] = [];
        try {
          available = await listSkills(tarball);
        } catch {
          // keep the base message
        }
        throw new SkillsFetchError(
          `the archive has no skills/${name}/SKILL.md — available: ${
            available.length > 0 ? available.join(", ") : "(none)"
          }`,
        );
      }
      const dest = path.join(staging, name);
      fs.renameSync(srcDir, dest);
      out.set(name, dest);
    }
    return out;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (err instanceof SkillsFetchError) throw err;
    throw new SkillsFetchError(`failed to unpack the skills archive: ${(err as Error).message}`);
  }
  // Note: `raw` is intentionally left in place on success — it holds the
  // non-requested skills and is removed by cleanupStaging along with the rest.
}

/** Extract a single skill. Returns the staging path with the skill's files at its root. */
export async function extractSkill(tarball: Buffer, skillName: string): Promise<string> {
  const dirs = await extractSkills(tarball, [skillName]);
  return dirs.get(skillName)!;
}

/** Clean up the staging dir (every extracted skill dir lives directly inside it). */
export function cleanupStaging(skillDir: string): void {
  fs.rmSync(path.dirname(skillDir), { recursive: true, force: true });
}
