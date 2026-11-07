import chalk from "chalk";
import stringWidth from "string-width";

/** One field seen across a collection's documents. */
export interface FieldInfo {
  /** Dot path; array elements that are objects use `[]`, e.g. `lines[].sku`. */
  path: string;
  /** Value types seen: string, number, boolean, null, object, array. */
  types: string[];
  /** How many documents have this field. */
  count: number;
  /** A sample scalar value, when there is one. */
  example?: unknown;
}

export interface CollectionSchema {
  collection: string;
  /** Documents read (capped at the sample size). */
  documents: number;
  /** True when the sample hit its cap, so there may be more documents. */
  more: boolean;
  fields: FieldInfo[];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

/** Infer the fields of a set of documents, nested objects and arrays of objects included. */
export function inferSchema(docs: readonly Record<string, unknown>[]): FieldInfo[] {
  const fields = new Map<string, { types: Set<string>; docs: Set<number>; example?: unknown }>();
  const see = (path: string, value: unknown, doc: number) => {
    let f = fields.get(path);
    if (!f) {
      f = { types: new Set(), docs: new Set() };
      fields.set(path, f);
    }
    const t = typeOf(value);
    f.types.add(t);
    f.docs.add(doc);
    if (f.example === undefined && t !== "object" && t !== "array" && t !== "null") {
      f.example = value;
    }
    if (f.example === undefined && t === "array" && (value as unknown[]).length > 0) {
      const scalars = (value as unknown[]).filter((x) => typeOf(x) !== "object");
      if (scalars.length > 0) f.example = value;
    }
    walk(value, path, doc);
  };
  const walk = (value: unknown, path: string, doc: number) => {
    const t = typeOf(value);
    if (t === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        see(path ? `${path}.${k}` : k, v, doc);
      }
    } else if (t === "array") {
      for (const el of value as unknown[]) {
        if (typeOf(el) === "object") walk(el, `${path}[]`, doc);
      }
    }
  };
  docs.forEach((d, i) => {
    walk(d, "", i);
  });
  const out = [...fields.entries()].map(([path, f]) => ({
    path,
    types: [...f.types],
    count: f.docs.size,
    ...(f.example === undefined ? {} : { example: f.example }),
  }));
  // _id first; otherwise keep first-seen order (parents before their children).
  return out.sort((a, b) => Number(b.path === "_id") - Number(a.path === "_id"));
}

/** The collections a statement reads or writes, in order of appearance. */
export function collectionsIn(statement: string): string[] {
  const names: string[] = [];
  const text = statement.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const re =
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][\w]*(?::[A-Za-z_]\w*)?)|\bON\s+([A-Za-z_]\w*)\s*\(/gi;
  for (const m of text.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function exampleText(v: unknown): string {
  if (typeof v === "string") return `'${v}'`;
  return JSON.stringify(v).replace(/"/g, "'");
}

/** The schema as styled lines for a panel `width` columns wide. */
export function schemaLines(schemas: readonly CollectionSchema[], width: number): string[] {
  const out: string[] = [];
  for (const [i, s] of schemas.entries()) {
    if (i > 0) out.push("");
    const n = `${s.documents}${s.more ? "+" : ""} document${s.documents === 1 ? "" : "s"}`;
    out.push(`${chalk.bold.magenta(s.collection)}  ${chalk.dim(n)}`);
    if (s.fields.length === 0) {
      out.push(chalk.dim("  (no documents)"));
      continue;
    }
    const pathWidth = Math.min(
      Math.max(...s.fields.map((f) => stringWidth(f.path))),
      Math.max(8, Math.floor(width * 0.45)),
    );
    for (const f of s.fields) {
      const path = f.path.length > pathWidth ? `${f.path.slice(0, pathWidth - 1)}…` : f.path;
      const partial = f.count < s.documents ? chalk.dim(` · ${f.count} of ${s.documents}`) : "";
      let line = `  ${chalk.cyan(path.padEnd(pathWidth))}  ${f.types.join("|")}${partial}`;
      if (f.example !== undefined) {
        const room = width - stringWidth(line) - 2;
        if (room >= 6) {
          let ex = exampleText(f.example);
          if (ex.length > room) ex = `${ex.slice(0, room - 1)}…`;
          line += `  ${chalk.dim(ex)}`;
        }
      }
      out.push(line);
    }
  }
  return out;
}

/** Names are case-sensitive: point out a name that only differs in case from a known one. */
export function caseMismatch(
  statement: string,
  known: { collections: readonly string[]; fields: readonly string[] },
): string | null {
  const text = statement.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const name of collectionsIn(text)) {
    const right = known.collections.find(
      (c) => c !== name && c.toLowerCase() === name.toLowerCase(),
    );
    if (right) {
      return `Collection names are case-sensitive: \`${name}\` is a different (empty) collection from \`${right}\`.`;
    }
  }
  for (const token of text.match(/[A-Za-z_]\w*/g) ?? []) {
    const right = known.fields.find((f) => f !== token && f.toLowerCase() === token.toLowerCase());
    if (right) {
      return `Field names are case-sensitive: \`${token}\` isn't the same field as \`${right}\`.`;
    }
  }
  return null;
}
