/**
 * Parser for the `~request_profile` envelope the Ditto SDK appends to result
 * sets of `PROFILE <SELECT>` statements. Tolerant by design — the envelope
 * shape is not a stable upstream contract (see spec risks). Field names
 * verified against SDK 5.1.0 (Spike C) and Edge Studio's parser.
 */

export interface ProfileTimes {
  elapsedNs?: number;
  parseNs?: number;
  planNs?: number;
  startIso?: string;
}

export interface PlanNode {
  name: string;
  stats?: {
    documentsIn?: number;
    documentsOut?: number;
    phaseTimes?: { exec?: number; recv?: number; send?: number };
  };
  /** Operator-specific attributes, insertion-ordered (skip #operator/#stats/children). */
  attributes: [string, unknown][];
  children: PlanNode[];
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

function parsePlanNode(node: Record<string, unknown>): PlanNode {
  const statsRaw = (node["#stats"] ?? {}) as Record<string, unknown>;
  const phaseRaw = (statsRaw.phaseTimes ?? {}) as Record<string, unknown>;
  const children = Array.isArray(node.children)
    ? (node.children as unknown[])
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => parsePlanNode(c))
    : [];

  const stats =
    Object.keys(statsRaw).length === 0
      ? undefined
      : {
          documentsIn: ns(statsRaw.documentsIn),
          documentsOut: ns(statsRaw.documentsOut),
          phaseTimes:
            Object.keys(phaseRaw).length === 0
              ? undefined
              : { exec: ns(phaseRaw.exec), recv: ns(phaseRaw.recv), send: ns(phaseRaw.send) },
        };

  const attributes: [string, unknown][] = Object.entries(node)
    .filter(([k]) => k !== "#operator" && k !== "#stats" && k !== "children")
    .map(([k, v]) => [k, v]);

  return {
    name: typeof node["#operator"] === "string" ? node["#operator"] : "unknown",
    stats,
    attributes,
    children,
  };
}
