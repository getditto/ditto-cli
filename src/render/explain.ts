import chalk from "chalk";

/**
 * EXPLAIN output is a plan JSON document (first item carries a `plan` key on
 * SDK 5.1). The shape is explicitly not a stable contract upstream, so this
 * is a tolerant pretty-printer: operator trees render as an indented tree
 * when recognizable, otherwise highlighted raw JSON.
 */
export function renderExplain(explainDoc: unknown): string {
  if (explainDoc === undefined || explainDoc === null) return "(plan unavailable)";
  const plan = (explainDoc as Record<string, unknown>).plan ?? explainDoc;

  const lines: string[] = [chalk.bold("Query plan")];
  if (isOperatorNode(plan)) {
    renderNode(plan, 0, lines);
  } else {
    lines.push(highlightJson(JSON.stringify(plan, null, 2)));
  }
  return lines.join("\n");
}

interface OpNode {
  operator?: string;
  children?: OpNode[];
  [key: string]: unknown;
}

function isOperatorNode(v: unknown): v is OpNode {
  return typeof v === "object" && v !== null && ("operator" in v || "#operator" in v);
}

function renderNode(node: OpNode, depth: number, lines: string[]): void {
  const name = (node["#operator"] ?? node.operator ?? "unknown") as string;
  const extras = Object.entries(node)
    .filter(([k]) => !["operator", "#operator", "children"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  lines.push(`${"  ".repeat(depth)}${depth === 0 ? "" : "└─ "}${chalk.bold(name)}${extras ? ` ${chalk.dim(extras)}` : ""}`);
  for (const child of node.children ?? []) {
    renderNode(child, depth + 1, lines);
  }
}

/** Minimal JSON syntax highlighting (keys cyan, strings green, numbers yellow). */
function highlightJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, `${chalk.cyan('"$1"')}:`)
    .replace(/: "([^"]*)"/g, `: ${chalk.green('"$1"')}`)
    .replace(/: (\d+\.?\d*)/g, `: ${chalk.yellow("$1")}`);
}
