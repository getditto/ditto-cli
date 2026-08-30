import catalog from "./benchmarks.json" with { type: "json" };
import { deterministicUuid, upsertAnchors } from "../../src/datasets/util.js";
import type { CatalogQuery, DatasetSuite, Doc, GenerateOptions, RngLike } from "../../src/datasets/types.js";

/**
 * retail — faithful port of tools/gen-retail-data.py from
 * getditto/dql-metrics-benchmark (denormalized, no-JOIN variant).
 * Faker replaced by deterministic name/email pools; RNG is our mulberry32 —
 * shape/distribution fidelity, not byte parity (spec §2).
 */

// ---------------------------------------------------------------------------
// Fixed catalogs (verbatim from gen-retail-data.py)
// ---------------------------------------------------------------------------

const STORES = [
  ["store_seattle", "Zava Retail Seattle", "Seattle", "WA", "98101", false, 3.0],
  ["store_online", "Zava Online", "Seattle", "WA", "98101", true, 3.0],
  ["store_bellevue", "Zava Retail Bellevue", "Bellevue", "WA", "98004", false, 1.0],
  ["store_tacoma", "Zava Retail Tacoma", "Tacoma", "WA", "98402", false, 1.0],
  ["store_redmond", "Zava Retail Redmond", "Redmond", "WA", "98052", false, 1.0],
  ["store_spokane", "Zava Retail Spokane", "Spokane", "WA", "99201", false, 1.0],
  ["store_olympia", "Zava Retail Olympia", "Olympia", "WA", "98501", false, 1.0],
  ["store_vancouver", "Zava Retail Vancouver", "Vancouver", "WA", "98660", false, 1.0],
] as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

const CATEGORIES: readonly (readonly [string, string, ...number[]])[] = [
  ["cat_hand_tools", "Hand Tools", 1.0, 1.0, 1.1, 1.2, 1.3, 1.3, 1.2, 1.1, 1.0, 1.0, 1.0, 1.0],
  ["cat_power_tools", "Power Tools", 0.8, 0.9, 1.1, 1.3, 1.4, 1.4, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8],
  ["cat_paint", "Paint", 0.9, 1.0, 1.5, 2.0, 2.2, 1.8, 1.4, 1.2, 1.1, 1.0, 0.9, 0.8],
  ["cat_lumber", "Lumber", 0.8, 0.8, 0.9, 1.1, 1.4, 1.8, 1.9, 1.5, 1.2, 1.0, 0.9, 0.8],
  ["cat_garden", "Garden", 0.5, 0.6, 1.2, 1.8, 2.0, 2.1, 1.8, 1.4, 1.0, 0.8, 0.6, 0.5],
  ["cat_plumbing", "Plumbing", 1.0, 1.0, 1.1, 1.1, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1, 1.2],
  ["cat_electrical", "Electrical", 1.0, 1.0, 1.1, 1.2, 1.1, 1.0, 1.0, 1.0, 1.0, 1.1, 1.2, 1.2],
  ["cat_hardware", "Hardware", 1.0, 1.0, 1.1, 1.2, 1.2, 1.1, 1.0, 1.0, 1.0, 1.0, 1.1, 1.1],
  ["cat_safety", "Safety", 1.0, 1.0, 1.0, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.0, 1.0, 1.0],
];

/** (categoryId, count, priceLow, priceHigh, skuPrefix) */
const PRODUCT_PLAN = [
  ["cat_hand_tools", 60, 9.99, 79.99, "HND"],
  ["cat_power_tools", 70, 49.99, 599.99, "PWR"],
  ["cat_paint", 50, 14.99, 89.99, "PNT"],
  ["cat_lumber", 40, 4.99, 149.99, "LMB"],
  ["cat_garden", 55, 7.99, 299.99, "GRD"],
  ["cat_plumbing", 45, 3.99, 199.99, "PLB"],
  ["cat_electrical", 40, 2.99, 149.99, "ELC"],
  ["cat_hardware", 30, 0.99, 49.99, "HRD"],
  ["cat_safety", 10, 4.99, 79.99, "SAF"],
] as const;

const FIRST_NAMES = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Sophia", "Mason", "Isabella", "Lucas"] as const;
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin"] as const;
const EMAIL_DOMAINS = ["example.net", "example.com", "example.org", "mail.example"] as const;

const EPOCH = Date.UTC(2022, 11, 9); // 2022-12-09
const END = Date.UTC(2025, 11, 9); // 2025-12-09
const DAY_MS = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function storeVolume(storeId: string): number {
  const row = STORES.find((s) => s[0] === storeId);
  if (!row) throw new Error(`unknown store ${storeId}`);
  return row[6];
}

function categorySeasonal(catId: string, monthIdx1to12: number): number {
  const row = CATEGORIES.find((c) => c[0] === catId);
  if (!row) throw new Error(`unknown category ${catId}`);
  return row[1 + monthIdx1to12] as number;
}

const YOY: Record<number, number> = { 2020: 1.0, 2021: 1.08, 2022: 1.17, 2023: 1.27, 2024: 1.39, 2025: 1.5, 2026: 1.53 };

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function generateStores(): Doc[] {
  return STORES.map(([sid, name, city, state, zip, isOnline]) => ({
    _id: sid,
    store_id: sid, // duplicated per Ditto connector requirement
    store_name: name,
    rls_user_id: deterministicUuid(sid),
    is_online: isOnline,
    location: { address: isOnline ? "n/a" : "123 Main St", city, state, zip },
    deleted: false,
  }));
}

export function generateCategories(): Doc[] {
  return CATEGORIES.map((row) => ({
    _id: row[0],
    category_id: row[0],
    category_name: row[1],
    seasonal_multipliers: Object.fromEntries(MONTHS.map((m, i) => [m, row[2 + i]])),
    deleted: false,
  }));
}

function productSpecs(catId: string, rng: RngLike): Doc {
  if (catId === "cat_power_tools") {
    return {
      voltage: rng.pick(["12V", "18V", "20V", "40V"] as const),
      battery_type: "Lithium-Ion",
      weight_lbs: Math.round(rng.uniform(1.5, 12.0) * 10) / 10,
    };
  }
  if (catId === "cat_paint") {
    return {
      finish: rng.pick(["matte", "satin", "semi-gloss", "gloss"] as const),
      size_oz: rng.pick([8, 16, 32, 128] as const),
    };
  }
  if (catId === "cat_lumber") {
    return {
      wood_type: rng.pick(["pine", "oak", "cedar", "redwood"] as const),
      treated: rng.pick([true, false] as const),
    };
  }
  return { weight_lbs: Math.round(rng.uniform(0.1, 20.0) * 10) / 10 };
}

export function generateProducts(rng: RngLike): Doc[] {
  const products: Doc[] = [];
  for (const [catId, count, lo, hi, prefix] of PRODUCT_PLAN) {
    for (let n = 0; n < count; n++) {
      const sku = `${prefix}-${String(n + 1).padStart(4, "0")}`;
      const basePrice = Math.round(rng.uniform(lo, hi) * 100) / 100;
      products.push({
        _id: `prod_${prefix.toLowerCase()}_${String(n + 1).padStart(4, "0")}`,
        product_id: `prod_${prefix.toLowerCase()}_${String(n + 1).padStart(4, "0")}`,
        sku,
        product_name: `${prefix} item ${String(n + 1).padStart(4, "0")}`,
        category_id: catId,
        cost: Math.round(basePrice * 0.67 * 100) / 100,
        base_price: basePrice,
        gross_margin_percent: 33.0,
        specifications: productSpecs(catId, rng),
        deleted: false,
      });
    }
  }
  return products;
}

export function generateCustomers(stores: Doc[], count: number, rng: RngLike, seed: number): Doc[] {
  const pool: string[] = [];
  for (const s of stores) pool.push(...Array(Math.round(storeVolume(s._id as string) * 10)).fill(s._id));

  const spanDays = Math.round((END - EPOCH) / DAY_MS);
  const customers: Doc[] = [];
  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const cid = deterministicUuid(`customer-${i}-${seed}`);
    customers.push({
      _id: cid,
      customer_id: cid,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@${rng.pick(EMAIL_DOMAINS)}`,
      phone: `+1-555-${String(rng.int(100, 999))}-${String(rng.int(1000, 9999))}`,
      primary_store_id: rng.pick(pool),
      created_at: iso(EPOCH + rng.int(0, spanDays) * DAY_MS + rng.int(0, 86_399) * 1000),
      deleted: false,
    });
  }
  return customers;
}

export function generateInventory(stores: Doc[], products: Doc[], rng: RngLike, skipRate = 0.01): Doc[] {
  const now = END;
  const out: Doc[] = [];
  for (const s of stores) {
    const sid = s._id as string;
    for (const p of products) {
      if (rng.chance(skipRate)) continue; // out-of-stock pairs are skipped
      const pid = p._id as string;
      out.push({
        _id: { store_id: sid, product_id: pid },
        store_id: sid,
        product_id: pid,
        stock_level: Math.max(0, Math.round(rng.gauss(30, 25))),
        location: { aisle: String(rng.int(1, 20)), shelf: rng.pick(["A", "B", "C", "D", "E", "F"] as const), bin: String(rng.int(1, 24)) },
        last_counted: iso(now - rng.int(0, 90) * DAY_MS - rng.int(0, 86_399) * 1000),
        notes: "",
        deleted: false,
      });
    }
  }
  return out;
}

interface OrdersResult {
  orders: Doc[];
  items: Doc[];
}

export function generateOrders(
  stores: Doc[],
  products: Doc[],
  customers: Doc[],
  targetOrders: number,
  rng: RngLike,
  seed: number,
): OrdersResult {
  const spanDays = Math.round((END - EPOCH) / DAY_MS);
  const byStore = new Map<string, Doc[]>();
  for (const c of customers) {
    const key = c.primary_store_id as string;
    if (!byStore.has(key)) byStore.set(key, []);
    byStore.get(key)!.push(c);
  }
  const storeMap = new Map(stores.map((s) => [s._id as string, s]));
  const productMap = new Map(products.map((p) => [p._id as string, p]));
  const productIds = [...productMap.keys()];

  const totalStoreWeight = STORES.reduce((s, [, , , , , , vol]) => s + vol, 0);
  // Sized to fill the full date span (so date-literal catalog queries keep
  // working); the hard cap is a safety, not the sizing mechanism.
  const basePerDay = targetOrders / (spanDays * totalStoreWeight * 1.05 * 1.25);

  const orders: Doc[] = [];
  const items: Doc[] = [];
  const seqPerDay = new Map<string, number>();

  outer: for (let dayOffset = 0; dayOffset <= spanDays; dayOffset++) {
    const day = EPOCH + dayOffset * DAY_MS;
    const d = new Date(day);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const dayStr = `${year}${String(month).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const avgSeasonal = CATEGORIES.reduce((s, c) => s + categorySeasonal(c[0], month), 0) / CATEGORIES.length;
    for (const [sid] of STORES) {
      const lam = basePerDay * storeVolume(sid) * avgSeasonal * (YOY[year] ?? 1.0);
      for (let k = 0; k < rng.poisson(lam); k++) {
        const sameStore = byStore.get(sid);
        const cust = rng.chance(0.95) && sameStore?.length ? rng.pick(sameStore) : rng.pick(customers);
        const seq = (seqPerDay.get(dayStr) ?? 0) + 1;
        seqPerDay.set(dayStr, seq);
        const oid = `order_${dayStr}_${String(seq).padStart(4, "0")}`;
        const ts = day + rng.int(8, 20) * 3_600_000 + rng.int(0, 59) * 60_000;

        let subtotal = 0;
        const lineCount = rng.int(1, 3);
        for (let line = 0; line < lineCount; line++) {
          const p = productMap.get(rng.pick(productIds))!;
          const qty = rng.int(1, 5);
          const disc = rng.pick([0, 0, 0, 5, 10, 15] as const);
          const lineTotal = Math.round((p.base_price as number) * qty * (1 - disc / 100) * 100) / 100;
          subtotal += lineTotal;
          items.push({
            _id: deterministicUuid(`item-${oid}-${line}-${seed}`),
            order_id: oid,
            store_id: sid,
            product_id: p._id,
            sku: p.sku,
            product_name: p.product_name,
            quantity: qty,
            unit_price: p.base_price,
            discount_percent: disc,
            line_total: lineTotal,
            deleted: false,
          });
        }
        subtotal = Math.round(subtotal * 100) / 100;
        const tax = Math.round(subtotal * 0.095 * 100) / 100;
        orders.push({
          _id: oid,
          order_id: oid,
          customer_id: cust._id,
          store_id: sid,
          order_date: iso(ts),
          customer_name: `${cust.first_name} ${cust.last_name}`,
          customer_email: cust.email,
          store_name: storeMap.get(sid)!.store_name,
          item_count: lineCount,
          subtotal,
          total: Math.round((subtotal + tax) * 100) / 100,
          status: "completed",
          deleted: false,
        });
        if (orders.length >= targetOrders) break outer;
      }
    }
  }
  return { orders, items };
}

// ---------------------------------------------------------------------------
// Catalog anchors — docs the vendored query literals reference. Applied via
// patch-or-append so ids that collide with formula-generated docs (the
// benchmark's anchors come from the same recipe) don't duplicate.
// ---------------------------------------------------------------------------

const ANCHOR_CUSTOMER: Doc = {
  _id: "e652232a-95ab-4fcf-86b7-e40cea3d749d",
  customer_id: "e652232a-95ab-4fcf-86b7-e40cea3d749d",
  first_name: "John",
  last_name: "Anchor",
  email: "john21@example.net",
  phone: "+1-555-010-2100",
  primary_store_id: "store_seattle",
  created_at: "2023-03-15T12:00:00Z",
  deleted: false,
};

/** orders__select__by_customer literal — must own ≥1 order. */
const ANCHOR_CUSTOMER_2: Doc = {
  _id: "d0b7e4cf-2479-4bd6-933b-7c260eefe0ee",
  customer_id: "d0b7e4cf-2479-4bd6-933b-7c260eefe0ee",
  first_name: "Casey",
  last_name: "Anchor",
  email: "casey.anchor@example.net",
  phone: "+1-555-010-7799",
  primary_store_id: "store_seattle",
  created_at: "2023-07-04T12:00:00Z",
  deleted: false,
};

function anchorOrder(): { order: Doc; item: Doc } {
  const order: Doc = {
    _id: "order_20250115_0001",
    order_id: "order_20250115_0001",
    customer_id: ANCHOR_CUSTOMER_2._id,
    store_id: "store_seattle",
    order_date: "2025-01-15T14:30:00Z",
    customer_name: "Casey Anchor",
    customer_email: ANCHOR_CUSTOMER_2.email,
    store_name: "Zava Retail Seattle",
    item_count: 1,
    subtotal: 100.0,
    total: 109.5,
    status: "completed",
    deleted: false,
  };
  const item: Doc = {
    _id: "705d8eda-4606-4551-b505-5d230d38aa8a",
    order_id: "order_20250115_0001",
    store_id: "store_seattle",
    product_id: "prod_pwr_0001",
    sku: "PWR-0001",
    product_name: "PWR item 0001",
    quantity: 2,
    unit_price: 50.0,
    discount_percent: 0,
    line_total: 100.0,
    deleted: false,
  };
  return { order, item };
}

// ---------------------------------------------------------------------------
// Suite assembly
// ---------------------------------------------------------------------------

function generate({ docs, rng, seed }: GenerateOptions) {
  const stores = generateStores();
  const categories = generateCategories();
  const products = generateProducts(rng);
  const customerCount = Math.max(50, Math.round(docs / 4));
  const customers = generateCustomers(stores, customerCount, rng, seed);
  const inventory = generateInventory(stores, products, rng);
  const { orders, items } = generateOrders(stores, products, customers, docs, rng, seed);

  const anchor = anchorOrder();
  upsertAnchors(customers, [ANCHOR_CUSTOMER, ANCHOR_CUSTOMER_2]);
  upsertAnchors(orders, [anchor.order]);
  upsertAnchors(items, [anchor.item]);

  return [
    { collection: "stores", docs: stores },
    { collection: "categories", docs: categories },
    { collection: "products", docs: products },
    { collection: "customers", docs: customers },
    { collection: "inventory", docs: inventory },
    { collection: "orders", docs: orders },
    { collection: "order_items", docs: items },
  ];
}

const suite: DatasetSuite = {
  name: "retail",
  description:
    "Zava Retail star schema, denormalized (no JOINs needed): 8 stores, 9 categories, 400 products, customers/inventory/orders/order_items scaled by --docs. Ported from dql-metrics-benchmark.",
  scalingDimension: "orders",
  defaultDocs: 5_000,
  collections: [
    { name: "stores", shape: "_id/store_id, store_name, rls_user_id, is_online, location{address,city,state,zip}, deleted (8 fixed docs)" },
    { name: "categories", shape: "_id, category_name, seasonal_multipliers{jan..dec}, deleted (9 fixed docs)" },
    { name: "products", shape: "_id, sku, product_name, category_id, cost, base_price, gross_margin_percent, specifications{…}, deleted (400 fixed)" },
    { name: "customers", shape: "_id (uuid), first_name, last_name, email, phone, primary_store_id, created_at, deleted (~docs/4)" },
    { name: "inventory", shape: "_id {store_id,product_id}, stock_level, location{aisle,shelf,bin}, last_counted, deleted (~8×400×0.99)" },
    { name: "orders", shape: "_id order_YYYYMMDD_NNNN, customer_id, store_id, order_date, customer_name/email, store_name, item_count, subtotal, total, status, deleted (scales with --docs)" },
    { name: "order_items", shape: "_id (uuid), order_id, store_id, product_id, sku, quantity, unit_price, discount_percent, line_total, deleted (~2× orders)" },
  ],
  setupStatements: [
    "CREATE INDEX customers_email ON customers (email)",
    "CREATE INDEX customers_primary_store ON customers (primary_store_id, deleted)",
    "CREATE INDEX products_sku ON products (sku)",
    "CREATE INDEX products_category ON products (category_id, deleted)",
    "CREATE INDEX products_price ON products (deleted, base_price)",
    "CREATE INDEX inventory_store ON inventory (_id.store_id, deleted)",
    "CREATE INDEX orders_store ON orders (store_id, deleted)",
    "CREATE INDEX orders_date ON orders (deleted, order_date)",
    "CREATE INDEX orders_store_status_date ON orders (store_id, status, order_date)",
    "CREATE INDEX order_items_order ON order_items (order_id)",
  ],
  catalog: catalog as unknown as Record<string, CatalogQuery>,
  generate,
};

export default suite;
