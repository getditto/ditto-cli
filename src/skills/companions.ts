import fs from "node:fs";
import path from "node:path";

/**
 * Companion skills: the other skills a skill links to with relative paths such
 * as `../js-sdk/assets/runtime.ts`. Those links resolve only when the linked
 * skill is installed next to it, so `skills add` installs them together.
 *
 * Links are read from the skill's files, not from a list in the CLI, so a new
 * upstream skill family works without a CLI change. Example (agent-skills
 * v0.6.0): `js-node` links to `js-sdk`, which links to every other `js-*`
 * skill and to `native-app-config`.
 */

/** Text files worth scanning for links. Assets like images are skipped. */
const TEXT_FILE = /\.(md|mdx|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|swift|kt|kts)$/i;

/** `../<name>/` — one or more `../` segments followed by a directory name. */
const SIBLING_LINK = /(?:\.\.\/)+([a-z0-9][a-z0-9-]*)\//g;

/** Skills that `skillDir` links to, limited to names in `available` (never itself). */
export function linkedSkills(skillDir: string, self: string, available: Set<string>): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(SIBLING_LINK)) {
          const name = m[1]!;
          if (name !== self && available.has(name)) found.add(name);
        }
      }
    }
  };
  walk(skillDir);
  return [...found].sort();
}

/**
 * The requested skills plus every skill they link to, followed transitively.
 * `dirs` maps each available skill name to its extracted directory.
 * Returns requested names first (in order), then companions sorted by name.
 */
export function withCompanions(requested: string[], dirs: Map<string, string>): string[] {
  const available = new Set(dirs.keys());
  const seen = new Set(requested);
  const queue = [...requested];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const dir = dirs.get(name);
    if (!dir) continue;
    for (const linked of linkedSkills(dir, name, available)) {
      if (!seen.has(linked)) {
        seen.add(linked);
        queue.push(linked);
      }
    }
  }
  const companions = [...seen].filter((n) => !requested.includes(n)).sort();
  return [...requested, ...companions];
}
