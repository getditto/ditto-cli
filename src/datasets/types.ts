/**
 * Dataset suite model. Suites are vendored definitions living in
 * `datasets/<name>/` (suite.ts + benchmarks.json) — no generated data is
 * ever committed (see spec §2).
 */

export type Doc = Record<string, unknown>;

/** One entry in the vendored benchmark query catalog (benchmarks.json). */
export interface CatalogQuery {
  query: string;
  category: string;
  preQueries?: string[];
  resetQueries?: string[];
  postQueries?: string[];
  expected_count?: number;
  expected_first_rows_hash?: string;
  negative?: boolean;
  expected_error_substring?: string;
  sql_equivalent?: string;
}

export interface CollectionSpec {
  name: string;
  /** Human-readable shape description for `dataset show`. */
  shape: string;
}

/** A batch of generated documents for one collection (loader chunks these). */
export interface CollectionBatch {
  collection: string;
  docs: Doc[];
}

export interface GenerateOptions {
  /** Value of the scaling dimension (--docs): movie count for movies, order count otherwise. */
  docs: number;
  /** Seed for deterministicUuid-driven fields and reproducibility metadata. */
  seed: number;
  rng: RngLike;
}

export interface RngLike {
  next(): number;
  int(min: number, max: number): number;
  uniform(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(pairs: readonly (readonly [T, number])[]): T;
  chance(p: number): boolean;
  gauss(mean: number, stddev: number): number;
  poisson(lambda: number): number;
  sample<T>(items: readonly T[], n: number): T[];
  uuid(): string;
}

export interface DatasetSuite {
  name: string;
  description: string;
  /** What --docs scales (e.g. "movies", "orders"). */
  scalingDimension: string;
  defaultDocs: number;
  collections: CollectionSpec[];
  /** Vendored query catalog (benchmarks.json), keyed by query name. */
  catalog: Record<string, CatalogQuery>;
  /** Known upstream issues per catalog query (e.g. SDK hangs) — shown by `dataset show`, warned by `dataset run`. */
  knownIssues?: Record<string, string>;
  /** Generate documents in dependency order (e.g. stores before orders). */
  generate(opts: GenerateOptions): CollectionBatch[];
}
