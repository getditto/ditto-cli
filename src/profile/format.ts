/** ns → human string, matching Edge Studio's formatNs exactly. */
export function formatNs(ns?: number): string {
  if (ns === undefined || Number.isNaN(ns)) return "—";
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${Math.round(ns)} ns`;
}

/** "12.3%" of total, or null when below the threshold (Edge Studio rule: 0.05). */
export function percentOfTotal(ns: number | undefined, total: number, threshold = 0.05): string | null {
  if (ns === undefined || total <= 0) return null;
  const ratio = ns / total;
  if (ratio < threshold) return null;
  return `${(ratio * 100).toFixed(1)}%`;
}
