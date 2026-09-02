import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { cleanupStaging, extractSkill } from "../../src/skills/fetch.js";
import { SkillsFetchError } from "../../src/skills/github.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

/** Build a real codeload-shaped tarball (<root>/skills/<name>/...) in a tmp dir. */
async function makeTarball(
  files: Record<string, string>,
  root = "getditto-agent-skills-abc123",
): Promise<Buffer> {
  const src = tmpDataDir("ditto-tar-src-");
  const tgz = path.join(tmpDataDir("ditto-tar-"), "repo.tar.gz");
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(src, root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    await tar.c({ file: tgz, cwd: src }, [root]);
    return fs.readFileSync(tgz);
  } finally {
    rmrf(src);
    rmrf(path.dirname(tgz));
  }
}

describe("extractSkill", () => {
  it("extracts skills/<name>/ to the skill root with SKILL.md at top", async () => {
    const tarball = await makeTarball({
      "skills/dql/SKILL.md": "# dql\n",
      "skills/dql/references/indexing.md": "# indexing\n",
      "skills/other/SKILL.md": "# other\n",
      "README.md": "# repo\n",
    });
    const out = await extractSkill(tarball, "dql");
    try {
      expect(fs.existsSync(path.join(out, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(out, "references", "indexing.md"))).toBe(true);
      // other skills + repo files are not extracted
      expect(fs.existsSync(path.join(out, "README.md"))).toBe(false);
      expect(fs.existsSync(path.join(out, "other"))).toBe(false);
    } finally {
      cleanupStaging(out);
    }
  });

  it("filters macOS metadata junk", async () => {
    const tarball = await makeTarball({
      "skills/dql/SKILL.md": "# dql\n",
      "skills/dql/._SKILL.md": "junk",
      "skills/dql/.DS_Store": "junk",
    });
    const out = await extractSkill(tarball, "dql");
    try {
      expect(fs.readdirSync(out)).toEqual(["SKILL.md"]);
    } finally {
      cleanupStaging(out);
    }
  });

  it("throws SkillsFetchError when the skill isn't in the tarball", async () => {
    const tarball = await makeTarball({ "skills/other/SKILL.md": "# other\n" });
    await expect(extractSkill(tarball, "dql")).rejects.toThrow(SkillsFetchError);
  });
});
