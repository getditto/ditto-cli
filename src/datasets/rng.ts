/**
 * Deterministic seeded RNG for dataset generation (mulberry32) plus the
 * sampling helpers the suite generators need. Same seed ⇒ identical output.
 *
 * Not CPython-compatible with the benchmark repo's Python generators — we
 * guarantee shape/distribution fidelity, not byte parity (see spec §2).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Random element. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  /** Weighted pick from [value, weight] pairs. */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of pairs) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return pairs[pairs.length - 1]![0];
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Approximately gaussian via Box–Muller. */
  gauss(mean: number, stddev: number): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Poisson count (Knuth's algorithm; normal approximation for large lambda — Knuth underflows past ~745). */
  poisson(lambda: number): number {
    if (lambda > 700) {
      return Math.max(0, Math.round(this.gauss(lambda, Math.sqrt(lambda))));
    }
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  /** Sample `n` distinct elements without replacement. */
  sample<T>(items: readonly T[], n: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < Math.min(n, pool.length); i++) {
      out.push(pool.splice(this.int(0, pool.length - 1), 1)[0]!);
    }
    return out;
  }

  /** 128 random bits as a UUID v4 string. */
  uuid(): string {
    const hex = Array.from({ length: 4 }, () =>
      Math.floor(this.next() * 0xffffffff)
        .toString(16)
        .padStart(8, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}
