import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { SkillsFetchError } from "./github.js";

/**
 * Extract `skills/<name>/` from a repo tarball into a fresh staging dir.
 * Tarballs from codeload carry a `<owner>-<repo>-<sha>/` root prefix.
 * Only regular files/dirs are extracted (symlinks and other entry types are
 * dropped — we install copies, never links, per the Windows-safe design).
 * Returns the staging path holding the skill's files at its root.
 */
export async function extractSkill(tarball: Buffer, skillName: string): Promise<string> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-skill-"));
  const out = path.join(staging, "skill");
  try {
    const tgz = path.join(staging, "repo.tar.gz");
    fs.writeFileSync(tgz, tarball);

    fs.mkdirSync(out, { recursive: true });
    // String prefix matching, not a regex — skillName never interpolates into a pattern.
    const prefix = `skills/${skillName}/`;
    await tar.x({
      file: tgz,
      cwd: out,
      filter: (p, entry) => {
        const entryType = "type" in entry ? entry.type : "File";
        if (entryType !== "File" && entryType !== "Directory") return false; // no symlinks/links/devices
        const base = path.posix.basename(p);
        if (base.startsWith("._") || base === ".DS_Store") return false; // macOS metadata junk
        const rel = p.replace(/^[^/]+\//, ""); // strip <owner>-<repo>-<sha>/
        return rel.startsWith(prefix) && rel.length > prefix.length;
      },
      strip: 3, // <root>/skills/<name>/ → skill root
    });

    // Sanity: the skill must contain its SKILL.md.
    if (!fs.existsSync(path.join(out, "SKILL.md"))) {
      throw new SkillsFetchError(
        `the tarball has no skills/${skillName}/SKILL.md — was the skill renamed?`,
      );
    }
    return out;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (err instanceof SkillsFetchError) throw err;
    throw new SkillsFetchError(`failed to unpack the skills tarball: ${(err as Error).message}`);
  }
}

/** Clean up the staging dir's parent (the extracted skill dir lives inside it). */
export function cleanupStaging(skillDir: string): void {
  fs.rmSync(path.dirname(skillDir), { recursive: true, force: true });
}
