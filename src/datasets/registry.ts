import movies from "../../datasets/movies/suite.js";
import pos from "../../datasets/pos/suite.js";
import retailJoins from "../../datasets/retail-joins/suite.js";
import retail from "../../datasets/retail/suite.js";
import { Rng } from "./rng.js";
import type { CatalogQuery, DatasetSuite } from "./types.js";

export { deterministicUuid, upsertAnchors } from "./util.js";

/** All bundled datasets, in display order. */
export const DATASETS: DatasetSuite[] = [movies, retail, retailJoins, pos];

export function getDataset(name: string): DatasetSuite | undefined {
  return DATASETS.find((d) => d.name === name);
}

/** Vendored query catalogs (benchmarks.json), keyed by dataset name. */
export function getCatalog(suite: DatasetSuite): Record<string, CatalogQuery> {
  return suite.catalog;
}

export interface ResolvedQuery {
  dataset: DatasetSuite;
  name: string;
  entry: CatalogQuery;
}

export class AmbiguousQueryError extends Error {
  constructor(
    public readonly queryName: string,
    public readonly matches: string[],
  ) {
    super(`Query "${queryName}" exists in multiple datasets: ${matches.join(", ")}. Pass --dataset to disambiguate.`);
    this.name = "AmbiguousQueryError";
  }
}

/** Resolve a catalog query by name, across datasets unless --dataset narrows it. */
export function resolveQuery(queryName: string, datasetName?: string): ResolvedQuery | undefined {
  const suites = datasetName ? DATASETS.filter((d) => d.name === datasetName) : DATASETS;
  const matches: ResolvedQuery[] = [];
  for (const dataset of suites) {
    const entry = getCatalog(dataset)[queryName];
    if (entry) matches.push({ dataset, name: queryName, entry });
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new AmbiguousQueryError(queryName, matches.map((m) => m.dataset.name));
  }
  return matches[0]!;
}

/** Instantiate the seeded RNG for a load run. */
export function rngFor(seed: number): Rng {
  return new Rng(seed);
}
