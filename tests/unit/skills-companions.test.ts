import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkedSkills, withCompanions } from "../../src/skills/companions.js";
import { rmrf, tmpDataDir } from "../helpers/credentials.js";

let root: string;

/** Write skill files under <root>/<name>/ and return the name → dir map. */
function skills(files: Record<string, Record<string, string>>): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const [name, contents] of Object.entries(files)) {
    const dir = path.join(root, name);
    for (const [rel, text] of Object.entries(contents)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text, "utf8");
    }
    dirs.set(name, dir);
  }
  return dirs;
}

beforeEach(() => {
  root = tmpDataDir("ditto-companions-");
});

afterEach(() => {
  rmrf(root);
});

describe("linkedSkills", () => {
  it("finds sibling links in nested text files, ignoring itself and non-skills", () => {
    const dirs = skills({
      "js-node": {
        "SKILL.md": "See [the SDK](../js-sdk/SKILL.md) and ../tests/js-sdk/README.md",
        "references/setup.md": "Shared [config](../../native-app-config/SKILL.md)",
        "examples/x.md": "Back to [workflow](../references/workflow.md) and ../js-node/SKILL.md",
        "assets/logo.png": "../js-web/ (binary, not scanned)",
      },
      "js-sdk": { "SKILL.md": "# sdk" },
      "js-web": { "SKILL.md": "# web" },
      "native-app-config": { "SKILL.md": "# config" },
    });
    expect(linkedSkills(dirs.get("js-node")!, "js-node", new Set(dirs.keys()))).toEqual([
      "js-sdk",
      "native-app-config",
    ]);
  });
});

describe("withCompanions", () => {
  it("follows links transitively, requested names first", () => {
    const dirs = skills({
      "js-node": { "SKILL.md": "[sdk](../js-sdk/SKILL.md)" },
      "js-sdk": { "SKILL.md": "../js-web/SKILL.md ../native-app-config/SKILL.md" },
      "js-web": { "SKILL.md": "[back](../js-sdk/SKILL.md)" },
      "native-app-config": { "SKILL.md": "# config" },
      "write-dql": { "SKILL.md": "# dql" },
    });
    expect(withCompanions(["js-node"], dirs)).toEqual([
      "js-node",
      "js-sdk",
      "js-web",
      "native-app-config",
    ]);
  });

  it("returns only the request when nothing is linked", () => {
    const dirs = skills({
      "write-dql": { "SKILL.md": "# dql" },
      "kotlin-sdk": { "SKILL.md": "#" },
    });
    expect(withCompanions(["write-dql"], dirs)).toEqual(["write-dql"]);
  });
});
