/**
 * Timing statistics, computed the same way as the dql-metrics-benchmark
 * runners (Kotlin `Stats.kt`, Rust `stats.rs`): population standard
 * deviation, a true median for p50, and floor-indexed p95/p99. Matching them
 * keeps numbers from `dittosh dql bench` comparable with benchmark sweeps.
 */
export interface Stats {
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stdDev: number;
}

export function computeStats(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new Error("computeStats needs at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, x) => sum + x, 0) / n;
  const p50 = n % 2 === 0 ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2 : sorted[(n - 1) / 2]!;
  const variance = sorted.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;
  return {
    mean,
    p50,
    p95: sorted[Math.floor(n * 0.95)]!,
    p99: sorted[Math.floor(n * 0.99)]!,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    stdDev: Math.sqrt(variance),
  };
}

/** Adaptive warmup budget, as in the benchmark runners (and androidx.benchmark). */
export const WARMUP_TARGET_MS = 250;
export const WARMUP_MIN = 1;
export const WARMUP_MAX = 1000;

/**
 * How many warmup iterations fill the budget, given one pilot run's time.
 * A pilot that rounds to 0 ms counts as "very fast" (the cap); a negative
 * time is treated as garbage (the floor).
 */
export function decideWarmup(pilotMs: number, targetMs = WARMUP_TARGET_MS): number {
  if (pilotMs === 0) return WARMUP_MAX;
  if (pilotMs < 0) return WARMUP_MIN;
  return Math.min(WARMUP_MAX, Math.max(WARMUP_MIN, Math.ceil(targetMs / pilotMs)));
}
