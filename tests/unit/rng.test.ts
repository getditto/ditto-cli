import { describe, expect, it } from "vitest";
import { deterministicUuid } from "../../src/datasets/registry.js";
import { Rng } from "../../src/datasets/rng.js";

describe("Rng", () => {
  it("is deterministic for the same seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it("int stays in [min, max] inclusive", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("weighted respects zero weights and returns valid labels", () => {
    const rng = new Rng(11);
    const picks = new Set<string>();
    for (let i = 0; i < 200; i++)
      picks.add(
        rng.weighted([
          ["a", 0],
          ["b", 1],
          ["c", 5],
        ]),
      );
    expect(picks.has("a")).toBe(false);
    expect(picks).toEqual(new Set(["b", "c"]));
  });

  it("uuid produces RFC-4122 v4 shape", () => {
    const rng = new Rng(5);
    for (let i = 0; i < 50; i++) {
      expect(rng.uuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("poisson has the right rough mean", () => {
    const rng = new Rng(99);
    let sum = 0;
    for (let i = 0; i < 2000; i++) sum += rng.poisson(4);
    const mean = sum / 2000;
    expect(mean).toBeGreaterThan(3.4);
    expect(mean).toBeLessThan(4.6);
  });

  it("sample never repeats and respects bounds", () => {
    const rng = new Rng(3);
    const s = rng.sample([1, 2, 3, 4, 5], 3);
    expect(s).toHaveLength(3);
    expect(new Set(s).size).toBe(3);
    expect(rng.sample([1], 5)).toEqual([1]);
  });
});

describe("deterministicUuid", () => {
  it("matches the benchmark generator's anchor value for store_seattle", () => {
    // tools/gen-retail-data.py `_deterministic_uuid("store_seattle")`:
    expect(deterministicUuid("store_seattle")).toBe("8d7e9536-74a1-4101-967d-7f3103baa401");
  });
});
