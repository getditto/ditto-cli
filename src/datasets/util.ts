import crypto from "node:crypto";
import type { Doc } from "./types.js";

/**
 * Deterministic UUID v4 from a seed string (SHA-256 based) — the same
 * construction the benchmark generators use, so anchor values like the
 * Seattle store's rls_user_id match the query catalog's literals.
 */
export function deterministicUuid(seedText: string): string {
  const h = crypto.createHash("sha256").update(seedText).digest("hex");
  const variantNibble = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variantNibble}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Patch-or-append anchor documents: if a generated doc already carries the
 * anchor's _id (possible when anchor ids come from the same deterministic
 * formula), overwrite its fields with the anchor's; otherwise append.
 * Guarantees catalog-referenced ids exist exactly once.
 */
export function upsertAnchors(docs: Doc[], anchors: Doc[]): void {
  const byId = new Map(docs.map((d, i) => [JSON.stringify(d._id), i]));
  for (const anchor of anchors) {
    const key = JSON.stringify(anchor._id);
    const existing = byId.get(key);
    if (existing === undefined) {
      byId.set(key, docs.length);
      docs.push(structuredClone(anchor));
    } else {
      docs[existing] = { ...docs[existing], ...structuredClone(anchor) };
    }
  }
}
