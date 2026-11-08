import chalk from "chalk";
import { formatNs, percentOfTotal } from "../profile/format.js";
import { type AnnotatedNode, annotatePlan, keyAttribute } from "../profile/hotspots.js";
import type { PlanNode, PlanStats, QueryProfile } from "../profile/parse.js";
import { stripControlChars } from "./sanitize.js";

/** Longest attribute value shown before truncating with "…". */
const ATTR_MAX = 80;

/**
 * Edge Studio's profile view, rendered for the terminal:
 * header (query + capture time + envelope metadata) → summary strip → ASCII
 * plan tree with per-operator exec/pct + docs in/out/skipped and hotspot
 * flags, each followed by dim detail lines (recv/send/stor times, yield
 * counters, remaining operator attributes) → legend.
 */
export function renderProfile(profile: QueryProfile, originalQuery: string): string {
  const lines: string[] = [];

  lines.push(chalk.bold("Execution Profile"));
  lines.push(
    chalk.dim(`captured ${profile.times.startIso ?? "unknown"} · profile ${profile.id ?? "n/a"}`),
  );
  const meta = envelopeMeta(profile);
  if (meta) lines.push(chalk.dim(meta));
  lines.push(chalk.cyan(`  ${originalQuery}`));
  lines.push("");

  const annotated = profile.plan ? annotatePlan(profile.plan) : [];

  // Summary strip
  const cells: [string, string][] = [
    ["Elapsed", formatNs(profile.times.elapsedNs)],
    ["Parse", formatNs(profile.times.parseNs)],
    ["Plan", formatNs(profile.times.planNs)],
  ];
  if (profile.resultCount !== undefined) cells.push(["Results", String(profile.resultCount)]);
  if (profile.queryType) cells.push(["Type", profile.queryType]);
  if (profile.state) cells.push(["State", profile.state]);
  const storTotal = sum(annotated.map((n) => n.node.stats?.phaseTimes?.stor));
  if (storTotal !== undefined) cells.push(["Stor", formatNs(storTotal)]);
  const yieldTotal = sum(annotated.flatMap((n) => Object.values(n.node.stats?.yields ?? {})));
  if (yieldTotal !== undefined) cells.push(["Yields", yieldTotal.toLocaleString("en-US")]);
  lines.push(cells.map(([label, value]) => `${chalk.dim(label)} ${chalk.bold(value)}`).join("   "));
  lines.push("");

  if (profile.plan) {
    lines.push(chalk.bold("Execution plan"));
    const totalExec = annotated.reduce((s, n) => s + n.execNs, 0);
    for (const entry of annotated) {
      lines.push(operatorLine(entry, totalExec));
      const detailIndent = `${"  ".repeat(entry.depth)}${entry.depth === 0 ? "" : "   "}   `;
      for (const detail of operatorDetails(entry.node)) {
        lines.push(chalk.dim(`${detailIndent}${detail}`));
      }
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
    chalk.dim(
      "legend: exec = CPU inside operator · recv = waiting upstream · send = pushing downstream · stor = blocked on storage",
    ),
  );
  lines.push(
    chalk.dim(
      "        in/out/skipped = documents · yields = scheduler yields by reason (budget, sender, receiver, heartbeat) · inner = join subplan",
    ),
  );
  return lines.join("\n");
}

function operatorLine(entry: AnnotatedNode, totalExec: number): string {
  const { node, depth, label, execNs, isHotspot } = entry;
  const indent = "  ".repeat(depth);
  const branch = depth === 0 ? "" : "└─ ";
  const prefix = label ? `${chalk.magenta(`${stripControlChars(label)}:`)} ` : "";
  const keyAttr = keyAttribute(node);
  const pct = percentOfTotal(execNs, totalExec, 0.005) ?? "";
  const docs = formatDocs(node.stats);
  const parts = [formatNs(execNs) + (pct ? ` (${pct})` : ""), docs].filter(Boolean).join(" · ");
  const line = `${indent}${branch}${prefix}${chalk.bold(node.name)}${keyAttr ? ` ${chalk.dim(keyAttr)}` : ""}${parts ? ` — ${parts}` : ""}`;
  return isHotspot ? `${indent}${chalk.bgYellow.black(` ▲ HOT ${line.trim()} `)}` : line;
}

/** Dim lines under an operator: phase times, yields, then remaining attributes. */
function operatorDetails(node: PlanNode): string[] {
  const out: string[] = [];
  const phase = node.stats?.phaseTimes;
  const times = (["recv", "send", "stor"] as const)
    .filter((k) => phase?.[k] !== undefined)
    .map((k) => `${k} ${formatNs(phase?.[k])}`);
  if (times.length > 0) out.push(times.join(" · "));

  const yields = node.stats?.yields;
  if (yields) {
    const parts = Object.entries(yields)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${stripControlChars(k)} ${v.toLocaleString("en-US")}`);
    out.push(`yields: ${parts.join(" · ")}`);
  }

  const shownKey = keyAttribute(node)?.split("=")[0];
  const attrs = node.attributes
    .filter(([k]) => k !== shownKey)
    .map(([k, v]) => `${stripControlChars(k)}=${truncate(stripControlChars(attrValue(v)))}`);
  if (attrs.length > 0) out.push(attrs.join(" "));
  return out;
}

function attrValue(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
}

function truncate(s: string): string {
  return s.length > ATTR_MAX ? `${s.slice(0, ATTR_MAX - 1)}…` : s;
}

/** Header line for the rest of the envelope: db, request type, flags, directives. */
function envelopeMeta(profile: QueryProfile): string | undefined {
  const parts: string[] = [];
  if (profile.appId) parts.push(`db ${profile.appId}`);
  if (profile.requestType) parts.push(`request ${profile.requestType}`);
  if (profile.featureFlags) parts.push(`flags ${profile.featureFlags}`);
  const directives = Object.entries(profile.directives ?? {}).map(([k, v]) =>
    v === true ? k : `${k}=${attrValue(v)}`,
  );
  if (directives.length > 0) parts.push(`directives ${directives.join(", ")}`);
  return parts.length > 0 ? stripControlChars(parts.join(" · ")) : undefined;
}

function sum(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;
}

function formatDocs(stats?: PlanStats): string {
  const parts: string[] = [];
  if (stats?.documentsIn !== undefined) parts.push(`${stats.documentsIn} in`);
  if (stats?.documentsOut !== undefined) parts.push(`${stats.documentsOut} out`);
  if (stats?.documentsSkipped) parts.push(`${stats.documentsSkipped} skipped`);
  return parts.join(" / ");
}
