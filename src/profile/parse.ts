/**
 * Parser for the `~request_profile` envelope the Ditto SDK appends to result
 * sets of `PROFILE <SELECT>` statements. Tolerant by design — the envelope
 * shape is not a stable upstream contract (see spec risks). Field names
 * verified against SDK 5.1.0 (Spike C), re-verified on SDK 5.2.0 (which adds
 * `stor` phase time, `yields` counters, `documentsSkipped`, and `nlJoin.inner`
 * subplans), and kept in parity with the Ditto VS Code extension's parser.
 */

export interface ProfileTimes {
  elapsedNs?: number;
  parseNs?: number;
  planNs?: number;
  startIso?: string;
}

export interface PhaseTimes {
  /** CPU time inside the operator. */
  exec?: number;
  /** Time waiting on upstream operators to feed input. */
  recv?: number;
  /** Time pushing output to downstream operators. */
  send?: number;
  /** Time blocked on the store backend (SDK 5.1+). */
  stor?: number;
}

export interface PlanStats {
  documentsIn?: number;
  documentsOut?: number;
  /** Documents skipped without being emitted (SDK 5.1+). */
  documentsSkipped?: number;
  phaseTimes?: PhaseTimes;
  /**
   * Cooperative-scheduler yield counts keyed by reason (`budget`, `sender`,
   * `receiver`, `heartbeat`; SDK 5.1+). Zero counts are dropped; absent when
   * nothing yielded. Unknown future reasons pass through.
   */
  yields?: Record<string, number>;
}

export interface PlanNode {
  name: string;
  stats?: PlanStats;
  /** Operator-specific attributes, insertion-ordered (skip #operator/#stats/children/subplans). */
  attributes: [string, unknown][];
  children: PlanNode[];
  /** Labeled nested plans carried in non-`children` fields, e.g. `nlJoin.inner` (SDK 5.1+). */
  subplans?: { key: string; plan: PlanNode }[];
}

export interface QueryProfile {
  id?: string;
  appId?: string;
  queryType?: string;
  requestType?: string;
  resultCount?: number;
  state?: string;
  text?: string;
  featureFlags?: string;
  /** Request directives, e.g. `{ "#profile": true }`. */
  directives?: Record<string, unknown>;
  times: ProfileTimes;
  plan?: PlanNode;
}

/** Envelope marker keys — deliberately NOT `text` (user docs may carry it). */
const MARKERS = ["queryType", "requestType", "featureFlags", "state", "resultCount"] as const;

/**
 * Bare-form detection (the SDK wraps in `~request_profile` in practice, but a
 * bare dict is accepted). To avoid eating user rows, the bare form requires a
 * `times` object AND at least one other marker (Edge Studio uses any marker;
 * that would swallow a user doc carrying only `state`).
 */
function isProfileDict(v: Record<string, unknown>): boolean {
  if (typeof v.times !== "object" || v.times === null) return false;
  return MARKERS.some((k) => k in v);
}

/** Find and parse the trailing ~request_profile item, if present. */
export function parseProfileItem(row: unknown): QueryProfile | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const rec = row as Record<string, unknown>;
  const wrapped = rec["~request_profile"];
  if (typeof wrapped === "object" && wrapped !== null) {
    return parseEnvelope(wrapped as Record<string, unknown>);
  }
  if (isProfileDict(rec)) return parseEnvelope(rec);
  return undefined;
}

/** Strip the profile envelope from a row set; returns [rows, profile]. */
export function extractProfile(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[];
  profile?: QueryProfile;
} {
  for (let i = rows.length - 1; i >= 0; i--) {
    const profile = parseProfileItem(rows[i]);
    if (profile) {
      return { rows: [...rows.slice(0, i), ...rows.slice(i + 1)], profile };
    }
  }
  return { rows };
}

function ns(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseEnvelope(env: Record<string, unknown>): QueryProfile {
  const times = (env.times ?? {}) as Record<string, unknown>;
  return {
    id: typeof env._id === "string" ? env._id : undefined,
    appId:
      (typeof env.database_id === "string" ? env.database_id : undefined) ??
      (typeof env.app_id === "string" ? env.app_id : undefined),
    queryType: typeof env.queryType === "string" ? env.queryType : undefined,
    requestType: typeof env.requestType === "string" ? env.requestType : undefined,
    resultCount: ns(env.resultCount),
    state: typeof env.state === "string" ? env.state : undefined,
    text: typeof env.text === "string" ? env.text : undefined,
    featureFlags: typeof env.featureFlags === "string" ? env.featureFlags : undefined,
    directives: isRecord(env.directives) ? env.directives : undefined,
    times: {
      elapsedNs: ns(times.elapsed),
      parseNs: ns(times.parse),
      planNs: ns(times.plan),
      startIso: typeof times.start === "string" ? times.start : undefined,
    },
    plan:
      env.plan && typeof env.plan === "object"
        ? parsePlanNode(env.plan as Record<string, unknown>)
        : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPlanNode(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && typeof v["#operator"] === "string";
}

/** Non-zero numeric yield counters, or undefined when none fired. */
function parseYields(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = ns(v);
    if (n !== undefined && n !== 0) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStats(raw: unknown): PlanStats | undefined {
  if (!isRecord(raw) || Object.keys(raw).length === 0) return undefined;
  const phase = isRecord(raw.phaseTimes) ? raw.phaseTimes : undefined;
  return {
    documentsIn: ns(raw.documentsIn),
    documentsOut: ns(raw.documentsOut),
    documentsSkipped: ns(raw.documentsSkipped),
    phaseTimes:
      phase && Object.keys(phase).length > 0
        ? { exec: ns(phase.exec), recv: ns(phase.recv), send: ns(phase.send), stor: ns(phase.stor) }
        : undefined,
    yields: parseYields(raw.yields),
  };
}

const RESERVED = new Set(["#operator", "#stats", "children"]);

function parsePlanNode(node: Record<string, unknown>): PlanNode {
  const children = Array.isArray(node.children)
    ? (node.children as unknown[]).filter(isRecord).map((c) => parsePlanNode(c))
    : [];

  const attributes: [string, unknown][] = [];
  const subplans: { key: string; plan: PlanNode }[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (RESERVED.has(k)) continue;
    if (isPlanNode(v)) subplans.push({ key: k, plan: parsePlanNode(v) });
    else attributes.push([k, v]);
  }

  return {
    name: typeof node["#operator"] === "string" ? node["#operator"] : "unknown",
    stats: parseStats(node["#stats"]),
    attributes,
    children,
    ...(subplans.length > 0 ? { subplans } : {}),
  };
}
