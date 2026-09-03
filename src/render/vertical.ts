import chalk from "chalk";
import { cellText, collectColumns } from "./columns.js";
import { sanitizeCell } from "./sanitize.js";

/**
 * Vertical/expanded display (psql \x-style): one block per row, fields as
 * `key │ value` lines. Values are never truncated — the point of this mode
 * is seeing wide rows (nested JSON, long text) in full.
 */
export function renderVertical(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";

  const cols = collectColumns(rows);
  const keyWidth = Math.max(...cols.map((c) => sanitizeCell(c).length));

  const out: string[] = [];
  rows.forEach((row, i) => {
    out.push(chalk.dim(`── row ${i + 1} ${"─".repeat(20)}`));
    for (const c of cols) {
      const key = sanitizeCell(c).padEnd(keyWidth);
      out.push(`${chalk.bold(key)} │ ${sanitizeCell(cellText(row[c]))}`);
    }
  });
  out.push(`${rows.length} row${rows.length === 1 ? "" : "s"}`);
  return out.join("\n");
}
