import catalog from "./benchmarks.json" with { type: "json" };
import type { CatalogQuery, DatasetSuite, Doc, GenerateOptions } from "../../src/datasets/types.js";

/**
 * movies — modeled on the benchmark suite's mflix-style schema. The
 * benchmark's 23,539-doc real corpus is 37 MB (LFS) and is NOT vendored;
 * these generators synthesize shape-faithful documents from field pools.
 *
 * Invariants the query catalog depends on (from benchmarks/movies/README):
 *  - exactly one doc with _id.year === '1893' (the Blacksmith Scene anchor)
 *  - zero docs with _id.year === '1800'
 *  - _id.year is a STRING; _id is a composite object {id, title, year, type}
 *  - some titles contain "Star" (LIKE '%Star%'), some plots contain "love",
 *    some fullplots contain "adventure"
 */

const GENRES = ["Drama", "Comedy", "Action", "Adventure", "Sci-Fi", "Fantasy", "Horror", "Romance", "Thriller", "Documentary", "Crime", "Mystery", "Animation", "Family", "Short", "Western"] as const;
const RATED: readonly (readonly [string, number])[] = [
  ["G", 10], ["PG", 18], ["PG-13", 22], ["R", 25], ["NC-17", 3],
  ["UNRATED", 12], ["NOT RATED", 6], ["TV-MA", 4],
];
const COUNTRIES = [["USA"], ["UK"], ["France"], ["USA", "UK"], ["Germany"], ["Japan"], ["Canada"], ["USA", "Canada"]] as const;
const LANGUAGES = [["English"], ["English", "French"], ["Spanish"], ["Japanese"], ["German"]] as const;

const TITLE_A = ["Star", "Night", "Day", "Last", "First", "Golden", "Silent", "Broken", "Hidden", "Burning", "Star", "Lonely", "Crimson", "Wild", "Dark"] as const;
const TITLE_B = ["Wars", "Trek", "Runner", "River", "Mountain", "City", "Garden", "Harbor", "Mirror", "Shadow", "Light", "Storm", "Valley", "Road", "Signal"] as const;
const TITLE_C = ["of Time", "Returns", "Rising", "Falling", "Forever", "Begins", "Awakens", "at Dawn", "of Dreams", ""] as const;

const FIRST = ["Alex", "Maria", "Samuel", "Nina", "Jordan", "Taylor", "Casey", "Robin", "Jamie", "Morgan", "Riley", "Avery", "Charles", "William", "Dorothy", "Harold"] as const;
const LAST = ["Johnson", "Lopez", "Kim", "Patel", "Smith", "Morgan", "Lee", "Brown", "Garcia", "Davis", "Kayser", "Ott", "Dickson", "Miller", "Wilson"] as const;

const PLOT_BITS = [
  "A struggling writer discovers a hidden city beneath the streets.",
  "Two strangers fall in love on a night train across the country.",
  "A retired detective takes one last case that changes everything.",
  "Siblings inherit a mysterious house with a locked garden.",
  "A chef risks everything to open a restaurant nobody believes in.",
  "An astronaut wakes to find the mission has gone silently wrong.",
  "A love letter arrives fifty years too late, and love finds a way.",
  "Children map an adventure through the tunnels under their town.",
  "A musician loses her hearing and learns to love music differently.",
  "Rivals must cooperate when the adventure race goes off course.",
] as const;

/** The canonical anchor: guarantees `single_result` (year '1893') returns 1 row. */
const BLACKSMITH_SCENE: Doc = {
  _id: { id: "573a1390f29313caabcd4135", title: "Blacksmith Scene", year: "1893", type: "movie" },
  plot: "Three men hammer on an anvil and pass a bottle of beer around.",
  genres: ["Short"],
  runtime: 1,
  cast: ["Charles Kayser", "John Ott"],
  num_mflix_comments: 1,
  fullplot: "Three men hammer on an anvil and pass a bottle of beer around.",
  countries: ["USA"],
  released: "1893-05-09T00:00:00.000Z",
  directors: ["William K.L. Dickson"],
  rated: "UNRATED",
  awards: { wins: 1, nominations: 0, text: "1 win." },
  lastupdated: "2015-08-26 00:03:50.133000000",
  imdb: { rating: 6.2, votes: 1189, id: 5 },
  tomatoes: { viewer: { rating: 3, numReviews: 184, meter: 32 }, lastUpdated: "2015-06-28T18:34:09.000Z" },
};

function title(rng: GenerateOptions["rng"], i: number): string {
  const t = `${rng.pick(TITLE_A)} ${rng.pick(TITLE_B)} ${rng.pick(TITLE_C)}`.trim();
  return rng.chance(0.12) ? `${t} ${i}` : t;
}

function people(rng: GenerateOptions["rng"], n: number): string[] {
  return Array.from({ length: n }, () => `${rng.pick(FIRST)} ${rng.pick(LAST)}`);
}

function generate({ docs, rng }: GenerateOptions) {
  const movies: Doc[] = [structuredClone(BLACKSMITH_SCENE)];
  let have2001 = false;
  let haveStar = false;

  for (let i = 1; i < docs; i++) {
    const year = String(rng.int(1950, 2025));
    if (year === "2001") have2001 = true;
    const t = title(rng, i);
    if (t.includes("Star")) haveStar = true;
    const wins = Math.max(0, Math.round(rng.gauss(3, 5)));
    const nominations = wins + Math.max(0, Math.round(rng.gauss(2, 4)));
    const plot = rng.pick(PLOT_BITS);
    const full = `${plot} ${rng.pick(PLOT_BITS)}`;
    movies.push({
      _id: {
        id: `gen-${i.toString(16).padStart(20, "0")}`,
        title: t,
        year,
        type: "movie",
      },
      plot,
      genres: rng.sample(GENRES, rng.int(1, 3)),
      runtime: rng.int(60, 240),
      cast: people(rng, rng.int(2, 6)),
      num_mflix_comments: rng.int(0, 40),
      fullplot: full,
      countries: [...rng.pick(COUNTRIES)],
      released: `${year}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}T00:00:00.000Z`,
      directors: people(rng, rng.int(1, 2)),
      writers: rng.chance(0.7) ? people(rng, rng.int(1, 3)).map((n) => `${n} (screenplay)`) : undefined,
      rated: rng.weighted(RATED),
      awards: { wins, nominations, text: `${wins} wins & ${nominations} nominations.` },
      lastupdated: `2025-10-03 ${String(rng.int(0, 23)).padStart(2, "0")}:00:00.000000000`,
      imdb: {
        rating: Math.min(10, Math.max(0, Math.round(rng.gauss(6.9, 1.1) * 10) / 10)),
        votes: Math.max(0, Math.round(rng.gauss(40_000, 60_000))),
        id: 1_000_000 + i,
      },
      languages: rng.chance(0.8) ? [...rng.pick(LANGUAGES)] : undefined,
      tomatoes: rng.chance(0.7)
        ? {
            viewer: {
              rating: Math.min(5, Math.max(0, Math.round(rng.gauss(3.3, 0.8) * 10) / 10)),
              numReviews: rng.int(10, 5000),
              meter: rng.int(0, 100),
            },
            lastUpdated: "2025-10-03T12:00:00.000Z",
          }
        : undefined,
    });
  }

  // Invariant repair (cheap, deterministic): the catalog needs ≥1 '2001' doc
  // (exact_match_id) and ≥1 "Star" title (like_pattern / text_search_title).
  // `released` must stay consistent with `_id.year` for range queries.
  if (docs > 1 && !have2001) {
    const m = movies[1]! as { _id: { year: string }; released: string };
    m._id.year = "2001";
    m.released = `2001${m.released.slice(4)}`;
  }
  if (docs > 2 && !haveStar) {
    const m = movies[2]! as { _id: { title: string } };
    m._id.title = `Star ${m._id.title}`;
  }

  return [{ collection: "movies", docs: movies }];
}

const suite: DatasetSuite = {
  name: "movies",
  description:
    "mflix-style movie catalog: one collection, composite _id, nested awards/imdb/tomatoes. Ported from dql-metrics-benchmark (synthesized, not the 37 MB corpus).",
  scalingDimension: "movies",
  defaultDocs: 10_000,
  collections: [
    {
      name: "movies",
      shape: "_id {id,title,year(string),type}, plot, fullplot, genres[], cast[], directors[], writers[], rated, runtime, released, countries[], languages[], awards{wins,nominations,text}, imdb{rating,votes,id}, tomatoes{viewer{…}}, num_mflix_comments, lastupdated",
    },
  ],
  catalog: catalog as unknown as Record<string, CatalogQuery>,
  generate,
};

export default suite;
