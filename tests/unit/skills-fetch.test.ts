import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { cleanupStaging, extractSkill, extractSkills, listSkills } from "../../src/skills/fetch.js";
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

/** Build a release-asset-shaped tarball (skills/ at the archive root, no prefix). */
async function makeAssetTarball(files: Record<string, string>): Promise<Buffer> {
  const src = tmpDataDir("ditto-asset-src-");
  const tgz = path.join(tmpDataDir("ditto-asset-"), "asset.tar.gz");
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(src, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    await tar.c(
      { file: tgz, cwd: src },
      ["skills", "LICENSE.md", "skills-manifest.json"].filter((p) =>
        fs.existsSync(path.join(src, p)),
      ),
    );
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

describe("listSkills", () => {
  it("enumerates skills/*/SKILL.md from a codeload tarball, sorted", async () => {
    const tarball = await makeTarball({
      "skills/write-dql/SKILL.md": "# dql\n",
      "skills/swift-sdk/SKILL.md": "# swift\n",
      "skills/kotlin-sdk/SKILL.md": "# kotlin\n",
      "skills/no-skillmd/README.md": "# not a skill\n",
      "tests/kotlin-sdk/Main.kt": "// test only\n",
      "README.md": "# repo\n",
    });
    expect(await listSkills(tarball)).toEqual(["kotlin-sdk", "swift-sdk", "write-dql"]);
  });

  it("enumerates a release-asset archive (skills/ at the root, no prefix)", async () => {
    const tarball = await makeAssetTarball({
      "skills/swift-sdk/SKILL.md": "# swift\n",
      "skills/write-dql/SKILL.md": "# dql\n",
      "skills-manifest.json": "{}",
      "LICENSE.md": "Apache",
    });
    expect(await listSkills(tarball)).toEqual(["swift-sdk", "write-dql"]);
  });
});

describe("extractSkills", () => {
  it("extracts several skills in one call, each fully recursive", async () => {
    const tarball = await makeTarball({
      "skills/write-dql/SKILL.md": "# dql\n",
      "skills/write-dql/examples/movies.md": "# movies\n",
      "skills/kotlin-sdk/SKILL.md": "# kotlin\n",
      "skills/kotlin-sdk/references/gradle.md": "# gradle\n",
      "skills/swift-sdk/SKILL.md": "# swift\n",
    });
    const dirs = await extractSkills(tarball, ["write-dql", "kotlin-sdk"]);
    try {
      expect(dirs.size).toBe(2);
      expect(fs.existsSync(path.join(dirs.get("write-dql")!, "examples", "movies.md"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.get("kotlin-sdk")!, "references", "gradle.md"))).toBe(
        true,
      );
      // the unrequested skill was not staged
      expect(fs.existsSync(path.join(path.dirname(dirs.get("write-dql")!), "swift-sdk"))).toBe(
        false,
      );
    } finally {
      cleanupStaging(dirs.get("write-dql")!);
    }
  });

  it("handles the release-asset layout (no root prefix)", async () => {
    const tarball = await makeAssetTarball({
      "skills/swift-sdk/SKILL.md": "# swift\n",
      "skills/swift-sdk/references/lifetimes.md": "# lifetimes\n",
      "skills-manifest.json": "{}",
    });
    const dirs = await extractSkills(tarball, ["swift-sdk"]);
    try {
      expect(fs.existsSync(path.join(dirs.get("swift-sdk")!, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(dirs.get("swift-sdk")!, "references", "lifetimes.md"))).toBe(
        true,
      );
    } finally {
      cleanupStaging(dirs.get("swift-sdk")!);
    }
  });

  it("missing skill error names what the archive ships", async () => {
    const tarball = await makeTarball({
      "skills/swift-sdk/SKILL.md": "# swift\n",
      "skills/write-dql/SKILL.md": "# dql\n",
    });
    await expect(extractSkills(tarball, ["nope"])).rejects.toSatisfy(
      (e) =>
        e instanceof SkillsFetchError &&
        e.message.includes("nope") &&
        e.message.includes("swift-sdk") &&
        e.message.includes("write-dql"),
    );
  });

  it("preserves binary files byte-identically (e.g. gradle-wrapper.jar)", async () => {
    const src = tmpDataDir("ditto-bin-src-");
    const tgz = path.join(tmpDataDir("ditto-bin-"), "repo.tar.gz");
    const jar = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0xfd, 0x42]);
    try {
      const dir = path.join(src, "root", "skills", "kotlin-sdk", "assets", "gradle", "wrapper");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(src, "root", "skills", "kotlin-sdk", "SKILL.md"), "# kotlin\n");
      fs.writeFileSync(path.join(dir, "gradle-wrapper.jar"), jar);
      await tar.c({ file: tgz, cwd: src }, ["root"]);
      const dirs = await extractSkills(fs.readFileSync(tgz), ["kotlin-sdk"]);
      try {
        const roundTrip = fs.readFileSync(
          path.join(dirs.get("kotlin-sdk")!, "assets", "gradle", "wrapper", "gradle-wrapper.jar"),
        );
        expect(roundTrip.equals(jar)).toBe(true);
      } finally {
        cleanupStaging(dirs.get("kotlin-sdk")!);
      }
    } finally {
      rmrf(src);
      rmrf(path.dirname(tgz));
    }
  });
});
