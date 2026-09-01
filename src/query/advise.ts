/**
 * Extraction of ADVISE results. The SDK returns one row shaped
 * `{ advice: { statement, suggestedIndexes?, outcome? } }` (verified live on
 * 5.1.0). Forgiving by design: scans all rows, merges suggestions, drops
 * partial suggestions missing collection or statement (Edge Studio rules).
 */

export interface IndexSuggestion {
  collection: string;
  statement: string;
  reason?: string;
}

export interface QueryAdvice {
  /** The analyzed statement (echoed back by the SDK). */
  statement?: string;
  suggestedIndexes: IndexSuggestion[];
  /** Free-text outcome when there's nothing to advise (e.g. "no keys to advise on"). */
  outcome?: string;
}

export function extractQueryAdvice(rows: Record<string, unknown>[]): QueryAdvice | undefined {
  let advice: QueryAdvice | undefined;
  for (const row of rows) {
    const a = row.advice;
    if (typeof a !== "object" || a === null) continue;
    const rec = a as Record<string, unknown>;
    advice = advice ?? { suggestedIndexes: [] };
    if (typeof rec.statement === "string") advice.statement = rec.statement;
    if (typeof rec.outcome === "string") advice.outcome = rec.outcome;
    if (Array.isArray(rec.suggestedIndexes)) {
      for (const raw of rec.suggestedIndexes) {
        if (typeof raw !== "object" || raw === null) continue;
        const s = raw as Record<string, unknown>;
        if (
          typeof s.collection !== "string" ||
          typeof s.statement !== "string" ||
          s.statement.trim() === ""
        ) {
          continue; // drop partial suggestions
        }
        advice.suggestedIndexes.push({
          collection: s.collection,
          statement: s.statement,
          reason: typeof s.reason === "string" ? s.reason : undefined,
        });
      }
    }
  }
  return advice;
}
