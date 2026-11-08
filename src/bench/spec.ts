/**
 * Benchmark definitions: what `dittosh dql bench` times, and the statements
 * that set up and restore the store around it. The JSON file format is the
 * one dql-metrics-benchmark uses for its suites (`benchmarks.json`), so a
 * suite file from that repo runs here unchanged.
 */
export interface BenchSpec {
  name: string;
  /** The statement that is timed. */
  query: string;
  /** Run once, before warmup and the timed runs (e.g. CREATE INDEX). */
  preQueries: string[];
  /** Run before every warmup and timed run, untimed (restores state for writes). */
  resetQueries: string[];
  /** Run after every warmup and timed run that succeeds, untimed (undoes what a write did). */
  afterEachQueries: string[];
  /** Run once at the end, even after a failure (e.g. DROP INDEX, EVICT fixtures). */
  postQueries: string[];
  description?: string;
}

export class BenchSpecError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "BenchSpecError";
  }
}

const STATEMENT_LISTS = ["preQueries", "resetQueries", "afterEachQueries", "postQueries"] as const;

/** Keys the benchmark repo uses for its own tooling (oracles, labels); accepted and ignored. */
const IGNORED_KEYS = new Set([
  "category",
  "qb",
  "sql_equivalent",
  "expected_count",
  "expected_first_rows_hash",
  "negative",
  "expected_error_substring",
]);

const KNOWN_KEYS = ["name", "query", ...STATEMENT_LISTS, "description"];

/** Trim, and drop one trailing `;` (each statement runs on its own). */
export function cleanStatement(statement: string): string {
  return statement.trim().replace(/;\s*$/, "").trim();
}

function suggestKey(key: string): string | undefined {
  const flat = key.toLowerCase().replace(/[_-]/g, "");
  return KNOWN_KEYS.find((k) => k.toLowerCase() === flat || k.toLowerCase() === `${flat}queries`);
}

function statementList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") value = [value];
  if (!Array.isArray(value)) throw new BenchSpecError(`${where} must be a list of statements`);
  return value.map((s, i) => {
    if (typeof s !== "string" || cleanStatement(s) === "") {
      throw new BenchSpecError(`${where}[${i}] must be a non-empty statement string`);
    }
    return cleanStatement(s);
  });
}

function parseEntry(raw: unknown, name: string, where: string, allowName: boolean): BenchSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BenchSpecError(`${where} must be an object with a "query"`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (KNOWN_KEYS.includes(key) || IGNORED_KEYS.has(key)) continue;
    const hint = suggestKey(key);
    throw new BenchSpecError(
      `${where} has an unknown key "${key}"${hint ? ` (did you mean "${hint}"?)` : ""}. Known keys: ${KNOWN_KEYS.join(", ")}`,
    );
  }
  if (typeof entry.query !== "string" || cleanStatement(entry.query) === "") {
    throw new BenchSpecError(`${where} needs a "query" string (the statement to time)`);
  }
  let finalName = name;
  if (entry.name !== undefined) {
    if (!allowName) {
      throw new BenchSpecError(`${where}: "name" goes in the key of the entry, not inside it`);
    }
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      throw new BenchSpecError(`${where}.name must be a non-empty string`);
    }
    finalName = entry.name.trim();
  }
  if (entry.description !== undefined && typeof entry.description !== "string") {
    throw new BenchSpecError(`${where}.description must be a string`);
  }
  return {
    name: finalName,
    query: cleanStatement(entry.query),
    preQueries: statementList(entry.preQueries, `${where}.preQueries`),
    resetQueries: statementList(entry.resetQueries, `${where}.resetQueries`),
    afterEachQueries: statementList(entry.afterEachQueries, `${where}.afterEachQueries`),
    postQueries: statementList(entry.postQueries, `${where}.postQueries`),
    description: entry.description as string | undefined,
  };
}

/**
 * Parse a benchmark file. Three shapes are accepted:
 *  - a map of name → benchmark (the dql-metrics-benchmark `benchmarks.json` shape)
 *  - a list of benchmarks, each with an optional "name"
 *  - a single benchmark object (it has a top-level "query")
 */
export function parseBenchFile(text: string, label: string): BenchSpec[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new BenchSpecError(`${label} isn't valid JSON: ${(err as Error).message}`);
  }
  let specs: BenchSpec[];
  if (Array.isArray(data)) {
    specs = data.map((entry, i) => parseEntry(entry, `benchmark_${i + 1}`, `${label}[${i}]`, true));
  } else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if ("query" in obj) {
      specs = [parseEntry(obj, "benchmark", label, true)];
    } else {
      specs = Object.entries(obj).map(([name, entry]) =>
        parseEntry(entry, name, `${label}: "${name}"`, false),
      );
    }
  } else {
    throw new BenchSpecError(`${label} must hold a JSON object or list of benchmarks`);
  }
  if (specs.length === 0) throw new BenchSpecError(`${label} has no benchmarks`);
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.name))
      throw new BenchSpecError(`${label}: two benchmarks are named "${s.name}"`);
    seen.add(s.name);
  }
  return specs;
}

/** Keep only the named benchmarks (in file order); unknown names are a usage error. */
export function selectBenchmarks(specs: BenchSpec[], names: string[]): BenchSpec[] {
  if (names.length === 0) return specs;
  const missing = names.filter((n) => !specs.some((s) => s.name === n));
  if (missing.length > 0) {
    throw new BenchSpecError(
      `No benchmark named ${missing.map((m) => `"${m}"`).join(", ")}. In this file: ${specs.map((s) => s.name).join(", ")}`,
    );
  }
  return specs.filter((s) => names.includes(s.name));
}
