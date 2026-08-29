import chalk from "chalk";

/** String length ignoring ANSI escape codes (good enough for our own output). */
const ANSI = /\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
}

function cell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    // Ditto attachment handles surface as objects with an id + len.
    if (typeof v.id === "string" && typeof v.len === "number") {
      return `[attachment id=${v.id} len=${v.len}]`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Render rows as an ASCII table: `_id` column first, then the union of all
 * other keys in first-seen order.
 */
export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";

  const cols: string[] = [];
  const seen = new Set<string>();
  if (rows.some((r) => "_id" in r)) {
    cols.push("_id");
    seen.add("_id");
  }
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }

  const data = rows.map((row) => cols.map((c) => cell(row[c])));
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...data.map((r) => visibleLength(r[i] ?? ""))),
  );

  const line = (left: string, mid: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const row = (cells: string[]) =>
    "│ " + cells.map((c, i) => c + " ".repeat((widths[i] ?? 0) - visibleLength(c))).join(" │ ") + " │";

  const out: string[] = [];
  out.push(line("┌", "┬", "┐"));
  out.push(row(cols.map((c) => chalk.bold(c))));
  out.push(line("├", "┼", "┤"));
  for (const r of data) out.push(row(r));
  out.push(line("└", "┴", "┘"));
  out.push(`${rows.length} row${rows.length === 1 ? "" : "s"}`);
  return out.join("\n");
}
