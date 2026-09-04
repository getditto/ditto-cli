import type * as sdk from "@dittolive/ditto";

export type StatementKind =
  | "select"
  | "explain"
  | "profile"
  | "advise"
  | "mutation"
  | "ddl"
  | "other";

/** Strip leading whitespace and comments (loop-based — no backtracking regex). */
export function stripLeadingTrivia(s: string): string {
  let rest = s;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const nl = trimmed.indexOf("\n");
      if (nl === -1) return "";
      rest = trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) return trimmed;
      rest = trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

/** Classify a DQL statement by its first meaningful keyword. */
export function classify(statement: string): StatementKind {
  const word = /^([a-zA-Z]+)/.exec(stripLeadingTrivia(statement))?.[1]?.toUpperCase();
  switch (word) {
    case "SELECT":
      return "select";
    case "EXPLAIN":
      return "explain";
    case "PROFILE":
      return "profile";
    case "ADVISE":
      return "advise";
    case "INSERT":
    case "UPDATE":
    case "EVICT":
    case "DELETE":
    case "TOMBSTONE":
      return "mutation";
    case "CREATE":
    case "DROP":
    case "ALTER":
      return "ddl";
    default:
      return "other";
  }
}

/** Deep-convert BigInt values (SDK int64) so JSON.stringify never throws: ≤ MAX_SAFE_INTEGER → number, else → string. */
function normalizeBigInt(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(normalizeBigInt);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeBigInt(v)]));
  }
  return value;
}

/** Extract plain row objects from a QueryResult. */
export function extractRows(result: sdk.QueryResult): Record<string, unknown>[] {
  const items = result.items ?? [];
  return items.map((item) => {
    const value = (item as { value: unknown }).value;
    const resolved = typeof value === "function" ? (value as () => unknown)() : value;
    return (normalizeBigInt(resolved) ?? {}) as Record<string, unknown>;
  });
}

/** Cap rows and report truncation. */
export function capRows(
  rows: Record<string, unknown>[],
  maxRows: number,
): { rows: Record<string, unknown>[]; truncated: boolean; total: number } {
  const total = rows.length;
  if (total <= maxRows) return { rows, truncated: false, total };
  return { rows: rows.slice(0, maxRows), truncated: true, total };
}
