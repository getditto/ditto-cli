import { cellText, collectColumns } from "./columns.js";
import { stripControlChars } from "./sanitize.js";

/**
 * GitHub-flavored markdown table: `_id` first column, union-of-keys header,
 * nested values as compact JSON. Pipes are escaped, cell newlines become
 * <br> (a raw newline would split the table row).
 */
export function renderMarkdown(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";

  const cols = collectColumns(rows);
  // Backslashes first — escaping pipes alone would let a data `\|` (or a
  // trailing `\`) corrupt the table (CodeQL: incomplete string escaping).
  const esc = (s: string) =>
    stripControlChars(s)
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");

  const lines = [
    `| ${cols.map((c) => esc(c)).join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${cols.map((c) => esc(cellText(row[c]))).join(" | ")} |`);
  }
  return lines.join("\n");
}
