import { describe, expect, it } from "vitest";
import {
  AmbiguousQueryError,
  DATASETS,
  getDataset,
  resolveQuery,
} from "../../src/datasets/registry.js";
import { Rng } from "../../src/datasets/rng.js";
import type { CollectionBatch, Doc } from "../../src/datasets/types.js";

function gen(name: string, docs: number, seed = 42): CollectionBatch[] {
  const suite = getDataset(name)!;
  return suite.generate({ docs, seed, rng: new Rng(seed) });
}

function batch(batches: CollectionBatch[], collection: string): Doc[] {
  return batches.find((b) => b.collection === collection)?.docs ?? [];
}

describe("dataset registry", () => {
  it("bundles the four vendored suites with their catalogs", () => {
    expect(DATASETS.map((d) => d.name)).toEqual(["movies", "retail", "retail-joins", "pos"]);
    expect(Object.keys(getDataset("movies")!.catalog).length).toBe(49);
    expect(Object.keys(getDataset("retail")!.catalog).length).toBe(72);
    expect(Object.keys(getDataset("retail-joins")!.catalog).length).toBe(96);
    expect(Object.keys(getDataset("pos")!.catalog).length).toBe(44);
  });

  it("resolveQuery finds a unique query across datasets", () => {
    const r = resolveQuery("single_result");
    expect(r?.dataset.name).toBe("movies");
    expect(r?.entry.query).toContain("1893");
  });

  it("resolveQuery returns undefined for unknown names", () => {
    expect(resolveQuery("nope__nope")).toBeUndefined();
  });

  it("resolveQuery throws AmbiguousQueryError on cross-dataset collisions", () => {
    expect(() => resolveQuery("stores__select__all")).toThrow(AmbiguousQueryError);
    const r = resolveQuery("stores__select__all", "retail");
    expect(r?.dataset.name).toBe("retail");
  });
});

describe("movies generator", () => {
  const docs = batch(gen("movies", 200), "movies");

  it("generates exactly N docs with composite _id and string year", () => {
    expect(docs).toHaveLength(200);
    for (const d of docs.slice(0, 20)) {
      const id = d._id as Doc;
      expect(typeof id.id).toBe("string");
      expect(typeof id.title).toBe("string");
      expect(typeof id.year).toBe("string");
      expect(id.type).toBe("movie");
    }
  });

  it("honors the catalog invariants: exactly one 1893, zero 1800", () => {
    const years = docs.map((d) => (d._id as Doc).year);
    expect(years.filter((y) => y === "1893")).toHaveLength(1);
    expect(years).not.toContain("1800");
    expect(docs[0]).toMatchObject({ _id: { title: "Blacksmith Scene", year: "1893" } });
  });

  it("guarantees a 2001 doc and a 'Star' title (catalog literals)", () => {
    expect(docs.some((d) => (d._id as Doc).year === "2001")).toBe(true);
    expect(docs.some((d) => ((d._id as Doc).title as string).includes("Star"))).toBe(true);
  });

  it("is deterministic under the same seed", () => {
    const a = batch(gen("movies", 50, 7), "movies");
    const b = batch(gen("movies", 50, 7), "movies");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("retail generator", () => {
  const batches = gen("retail", 1_000);
  const stores = batch(batches, "stores");
  const categories = batch(batches, "categories");
  const products = batch(batches, "products");
  const customers = batch(batches, "customers");
  const inventory = batch(batches, "inventory");
  const orders = batch(batches, "orders");
  const items = batch(batches, "order_items");

  it("fixed catalog counts", () => {
    expect(stores).toHaveLength(8);
    expect(categories).toHaveLength(9);
    expect(products).toHaveLength(400);
  });

  it("scales orders to --docs (anchors patch-or-append, never duplicate)", () => {
    expect(orders.length).toBeGreaterThanOrEqual(1_000);
    expect(orders.length).toBeLessThanOrEqual(1_001);
    const orderIds = orders.map((o) => JSON.stringify(o._id));
    expect(new Set(orderIds).size).toBe(orderIds.length);
    expect(items.length).toBeGreaterThanOrEqual(1_000); // 1–3 per order
    expect(customers.length).toBeGreaterThanOrEqual(Math.max(50, Math.round(1000 / 4)));
  });

  it("Seattle store rls_user_id matches the catalog literal", () => {
    const seattle = stores.find((s) => s._id === "store_seattle")!;
    expect(seattle.rls_user_id).toBe("8d7e9536-74a1-4101-967d-7f3103baa401");
  });

  it("catalog anchors exist (order, customer, item, product)", () => {
    expect(orders.some((o) => o._id === "order_20250115_0001")).toBe(true);
    expect(customers.some((c) => c.email === "john21@example.net")).toBe(true);
    expect(items.some((i) => i._id === "705d8eda-4606-4551-b505-5d230d38aa8a")).toBe(true);
    expect(products.some((p) => p.sku === "PWR-0001")).toBe(true);
  });

  it("referential integrity", () => {
    const custIds = new Set(customers.map((c) => c._id));
    const orderIds = new Set(orders.map((o) => o._id));
    const prodIds = new Set(products.map((p) => p._id));
    for (const o of orders.slice(0, 100)) expect(custIds.has(o.customer_id)).toBe(true);
    for (const i of items.slice(0, 100)) {
      expect(orderIds.has(i.order_id)).toBe(true);
      expect(prodIds.has(i.product_id)).toBe(true);
    }
    const invIds = new Set(inventory.map((i) => JSON.stringify(i._id)));
    expect(invIds.size).toBe(inventory.length);
  });

  it("orders span the full 2022–2025 date range (date literals keep working)", () => {
    const dates = orders.map((o) => o.order_date as string).sort();
    expect(dates[0]! < "2023-01-01").toBe(true);
    expect(dates[dates.length - 1]! > "2025-06-01").toBe(true);
  });

  it("draws Poisson once per (day, store) — order count tracks --docs closely", () => {
    // Regression: re-drawing in the loop condition under-generated ~5%.
    expect(orders.length).toBeGreaterThanOrEqual(990);
    expect(orders.length).toBeLessThanOrEqual(1_001);
  });

  it("anchor order is internally consistent (item_count matches its items)", () => {
    const anchorItems = items.filter((i) => i.order_id === "order_20250115_0001");
    expect(anchorItems).toHaveLength(1);
    expect(anchorItems[0]!._id).toBe("705d8eda-4606-4551-b505-5d230d38aa8a");
    const anchor = orders.find((o) => o._id === "order_20250115_0001")!;
    expect(anchor.item_count).toBe(anchorItems.length);
  });
});

describe("retail-joins generator", () => {
  const batches = gen("retail-joins", 500);
  const productTypes = batch(batches, "product_types");
  const products = batch(batches, "products");
  const orders = batch(batches, "orders");
  const items = batch(batches, "order_items");
  const customers = batch(batches, "customers");

  it("is normalized: no denormalized fields on orders/items", () => {
    for (const o of orders) {
      expect(o).not.toHaveProperty("customer_name");
      expect(o).not.toHaveProperty("customer_email");
      expect(o).not.toHaveProperty("store_name");
    }
    for (const i of items) {
      expect(i).not.toHaveProperty("store_id");
      expect(i).not.toHaveProperty("sku");
      expect(i).not.toHaveProperty("product_name");
    }
  });

  it("has 32 product types and every product has a type in its category", () => {
    expect(productTypes).toHaveLength(32);
    const typeCat = new Map(productTypes.map((t) => [t._id as string, t.category_id as string]));
    for (const p of products) {
      expect(typeCat.get(p.type_id as string)).toBe(p.category_id);
    }
  });

  it("catalog anchors exist (first-day order, 3-order customer)", () => {
    expect(orders.some((o) => o._id === "order_20221209_0001")).toBe(true);
    const anchorOrders = orders.filter(
      (o) => o.customer_id === "d30977d3-fa5d-4e13-9175-f637bccc4c87",
    );
    expect(anchorOrders.length).toBeGreaterThanOrEqual(3);
    expect(customers.some((c) => c._id === "d30977d3-fa5d-4e13-9175-f637bccc4c87")).toBe(true);
  });

  it("anchor orders' item_count matches actual items (no stale generated items)", () => {
    for (const anchorId of ["order_20221209_0001", "order_20230110_0001", "order_20230615_0001"]) {
      const anchor = orders.find((o) => o._id === anchorId)!;
      const itsItems = items.filter((i) => i.order_id === anchorId);
      expect(itsItems.length).toBe(anchor.item_count);
    }
  });
});

describe("pos generator", () => {
  const batches = gen("pos", 1_000);
  const locations = batch(batches, "locations");
  const saleItems = batch(batches, "sale_items");
  const orders = batch(batches, "pos_orders");

  it("fixed catalogs: 7 locations, 47 sale items", () => {
    expect(locations).toHaveLength(7);
    expect(saleItems).toHaveLength(47);
  });

  it("scales orders to --docs plus anchors, spanning the 4 business days", () => {
    expect(orders).toHaveLength(1_002); // 1000 generated + 2 anchor orders
    const days = new Set(orders.map((o) => o.businessDay));
    expect(days).toEqual(new Set(["2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"]));
  });

  it("money invariant: subtotal + modifierTotal + tax == total (integer cents)", () => {
    for (const o of orders.slice(0, 200)) {
      const t = o.totals as Doc;
      const sum = (t.subtotal as Doc).amount as number;
      const mod = (t.modifierTotal as Doc).amount as number;
      const tax = (t.tax as Doc).amount as number;
      const total = (t.total as Doc).amount as number;
      expect(Number.isInteger(sum)).toBe(true);
      expect(sum + mod + tax).toBe(total);
    }
  });

  it("paid orders' payments sum to the total", () => {
    const paid = orders.filter((o) => o.paymentStatus === "paid").slice(0, 100);
    expect(paid.length).toBeGreaterThan(0);
    for (const o of paid) {
      const sum = Object.values(o.payments as Record<string, Doc>).reduce(
        (s, p) => s + ((p.amount as Doc).amount as number),
        0,
      );
      expect(sum).toBe(((o.totals as Doc).total as Doc).amount);
    }
  });

  it("catalog anchor order ids exist at location 00001", () => {
    const ids = new Set(orders.map((o) => (o._id as Doc).id));
    expect(ids.has("ce5a37a2-deaf-4254-b9da-d80505801d75")).toBe(true);
    expect(ids.has("376af023-9a9d-4c49-bcad-cf0c67717141")).toBe(true);
  });

  it("determinism under the same seed", () => {
    const a = batch(gen("pos", 100, 9), "pos_orders");
    const b = batch(gen("pos", 100, 9), "pos_orders");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
