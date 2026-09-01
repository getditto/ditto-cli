/**
 * CSV rendering: `_id` first column, union-of-keys header, nested values as
 * compact JSON, RFC-4180-style quoting.
 */
export function renderCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";

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

  const escapeCell = (value: unknown): string => {
    let s: string;
    if (value === null) s = "null";
    else if (value === undefined) s = "";
    else if (typeof value === "object") s = JSON.stringify(value);
    else s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [cols.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(row[c])).join(","));
  }
  return lines.join("\n");
}
