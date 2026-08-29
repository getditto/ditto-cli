import type * as sdk from "@dittolive/ditto";

export type StatementKind =
  | "select"
  | "explain"
  | "profile"
  | "advise"
  | "mutation"
  | "ddl"
  | "other";

const FIRST_WORD = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*([a-zA-Z]+)/;

/** Classify a DQL statement by its first meaningful keyword. */
export function classify(statement: string): StatementKind {
  const word = FIRST_WORD.exec(statement)?.[1]?.toUpperCase();
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

/** Extract plain row objects from a QueryResult. */
export function extractRows(result: sdk.QueryResult): Record<string, unknown>[] {
  const items = result.items ?? [];
  return items.map((item) => {
    const value = (item as { value: unknown }).value;
    const resolved = typeof value === "function" ? (value as () => unknown)() : value;
    return (resolved ?? {}) as Record<string, unknown>;
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
