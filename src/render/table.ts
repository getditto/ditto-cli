import chalk from "chalk";
import stringWidth from "string-width";
import { sanitizeCell } from "./sanitize.js";

/** Display width (accounts for CJK wide chars and emoji; strips ANSI codes). */
function visibleLength(s: string): number {
  return stringWidth(s);
}

function cell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    // Ditto attachment handles surface as objects with an id + len.
    if (
      typeof v.id === "string" &&
      typeof v.len === "number" &&
      ("metadata" in v || "mime_type" in v)
    ) {
      return `[attachment id=${sanitizeCell(v.id)} len=${v.len}]`;
    }
    return sanitizeCell(JSON.stringify(value));
  }
  return sanitizeCell(String(value));
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
  // Sanitize keys BEFORE measuring — control chars measure 0 wide but render
  // as markers (⏎/⇥), which would make repeat counts go negative (crash).
  const header = cols.map((c) => sanitizeCell(c));

  const data = rows.map((row) => cols.map((c) => cell(row[c])));
  // Loop, not spread — Math.max(...spread) overflows the call stack past ~150k rows.
  const widths = header.map((h, i) => {
    let w = visibleLength(h);
    for (const r of data) {
      const rw = visibleLength(r[i] ?? "");
      if (rw > w) w = rw;
    }
    return w;
  });

  const line = (left: string, mid: string, right: string) =>
    left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  const row = (cells: string[]) =>
    "│ " +
    cells.map((c, i) => c + " ".repeat((widths[i] ?? 0) - visibleLength(c))).join(" │ ") +
    " │";

  const out: string[] = [];
  out.push(line("┌", "┬", "┐"));
  out.push(row(header.map((h) => chalk.bold(h))));
  out.push(line("├", "┼", "┤"));
  for (const r of data) out.push(row(r));
  out.push(line("└", "┴", "┘"));
  out.push(`${rows.length} row${rows.length === 1 ? "" : "s"}`);
  return out.join("\n");
}
