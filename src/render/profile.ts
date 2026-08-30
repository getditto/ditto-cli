import chalk from "chalk";
import { formatNs, percentOfTotal } from "../profile/format.js";
import { annotatePlan, keyAttribute } from "../profile/hotspots.js";
import type { QueryProfile } from "../profile/parse.js";

/**
 * Edge Studio's profile view, rendered for the terminal:
 * header (query + capture time) → summary strip → ASCII plan tree with
 * per-operator exec/pct + docs in/out and hotspot flags → legend.
 */
export function renderProfile(profile: QueryProfile, originalQuery: string): string {
  const lines: string[] = [];

  lines.push(chalk.bold("Execution Profile"));
  lines.push(chalk.dim(`captured ${profile.times.startIso ?? "unknown"} · profile ${profile.id ?? "n/a"}`));
  lines.push(chalk.cyan(`  ${originalQuery}`));
  lines.push("");

  // Summary strip
  const cells: [string, string][] = [
    ["Elapsed", formatNs(profile.times.elapsedNs)],
    ["Parse", formatNs(profile.times.parseNs)],
    ["Plan", formatNs(profile.times.planNs)],
  ];
  if (profile.resultCount !== undefined) cells.push(["Results", String(profile.resultCount)]);
  if (profile.queryType) cells.push(["Type", profile.queryType]);
  if (profile.state) cells.push(["State", profile.state]);
  lines.push(cells.map(([label, value]) => `${chalk.dim(label)} ${chalk.bold(value)}`).join("   "));
  lines.push("");

  if (profile.plan) {
    lines.push(chalk.bold("Execution plan"));
    const annotated = annotatePlan(profile.plan);
    const totalExec = annotated.reduce((s, n) => s + n.execNs, 0);
    for (const { node, depth, execNs, fraction, isHotspot } of annotated) {
      const indent = "  ".repeat(depth);
      const branch = depth === 0 ? "" : "└─ ";
      const name = chalk.bold(node.name);
      const keyAttr = keyAttribute(node);
      const exec = formatNs(execNs);
      const pct = percentOfTotal(execNs, totalExec, 0.005) ?? "";
      const docs = formatDocs(node.stats?.documentsIn, node.stats?.documentsOut);
      const parts = [exec + (pct ? ` (${pct})` : ""), docs].filter(Boolean).join(" · ");
      const line = `${indent}${branch}${name}${keyAttr ? ` ${chalk.dim(keyAttr)}` : ""}${parts ? ` — ${parts}` : ""}`;
      lines.push(isHotspot ? chalk.bgYellow.black(` ▲ HOT ${line.trim()} `) : line);
    }
    if (annotated.some((n) => n.isHotspot)) {
      lines.push("");
      lines.push(chalk.yellow("▲ hotspot: operator consumed ≥50% of total exec time"));
    }
  } else {
    lines.push(chalk.dim("(plan unavailable)"));
  }

  lines.push("");
  lines.push(
    chalk.dim("legend: exec = CPU inside operator · recv = waiting upstream · send = pushing downstream · in/out = documents"),
  );
  return lines.join("\n");
}

function formatDocs(docsIn?: number, docsOut?: number): string {
  if (docsIn === undefined && docsOut === undefined) return "";
  if (docsIn === undefined) return `${docsOut} out`;
  if (docsOut === undefined) return `${docsIn} in`;
  return `${docsIn} in / ${docsOut} out`;
}
