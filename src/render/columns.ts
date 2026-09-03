/**
 * Shared row-shape logic for display renderers (table/markdown/html/vertical):
 * `_id` column first, then the union of all other keys in first-seen order.
 * CSV keeps its own copy deliberately (data interchange: no attachment
 * placeholders, no display-oriented cell text).
 */
export function collectColumns(rows: Record<string, unknown>[]): string[] {
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
  return cols;
}

/**
 * Raw display text for a cell value (no escaping/sanitizing — each renderer
 * applies its own). null → "null", undefined → "", nested values → compact
 * JSON, attachment handles → a placeholder.
 */
export function cellText(value: unknown): string {
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
      return `[attachment id=${v.id} len=${v.len}]`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}
