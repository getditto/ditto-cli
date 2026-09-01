import catalog from "./benchmarks.json" with { type: "json" };
import type { CatalogQuery, DatasetSuite, Doc, GenerateOptions } from "../../src/datasets/types.js";
import { deterministicUuid, upsertAnchors } from "../../src/datasets/util.js";
import {
  generateCategories,
  generateCustomers,
  generateInventory,
  generateOrders,
  generateProducts,
  generateStores,
} from "../retail/suite.js";

/**
 * retail-joins — normalized variant of the retail suite (port of
 * tools/gen-retail-joins-data.py): adds product_types, strips denormalized
 * fields from orders/order_items to force JOINs, and drops ~8% of inventory
 * pairs / reserves ~1% of customers and products (LEFT JOIN holes).
 */

const PRODUCT_TYPES = [
  ["ptype_hnd_hammer", "cat_hand_tools", "Hammer"],
  ["ptype_hnd_screwdriver", "cat_hand_tools", "Screwdriver"],
  ["ptype_hnd_wrench", "cat_hand_tools", "Wrench"],
  ["ptype_hnd_plier", "cat_hand_tools", "Plier"],
  ["ptype_hnd_other", "cat_hand_tools", "Other Hand Tool"],
  ["ptype_pwr_drill", "cat_power_tools", "Drill"],
  ["ptype_pwr_saw", "cat_power_tools", "Saw"],
  ["ptype_pwr_sander", "cat_power_tools", "Sander"],
  ["ptype_pwr_grinder", "cat_power_tools", "Grinder"],
  ["ptype_pwr_other", "cat_power_tools", "Other Power Tool"],
  ["ptype_pnt_interior", "cat_paint", "Interior Paint"],
  ["ptype_pnt_exterior", "cat_paint", "Exterior Paint"],
  ["ptype_pnt_primer", "cat_paint", "Primer"],
  ["ptype_pnt_brush", "cat_paint", "Brush / Roller"],
  ["ptype_lmb_dimensional", "cat_lumber", "Dimensional Lumber"],
  ["ptype_lmb_plywood", "cat_lumber", "Plywood / Sheet"],
  ["ptype_lmb_treated", "cat_lumber", "Pressure-Treated"],
  ["ptype_grd_tool", "cat_garden", "Garden Tool"],
  ["ptype_grd_plant", "cat_garden", "Plant / Seed"],
  ["ptype_grd_soil", "cat_garden", "Soil / Fertilizer"],
  ["ptype_grd_furniture", "cat_garden", "Outdoor Furniture"],
  ["ptype_plb_pipe", "cat_plumbing", "Pipe / Fitting"],
  ["ptype_plb_valve", "cat_plumbing", "Valve / Faucet"],
  ["ptype_plb_fixture", "cat_plumbing", "Fixture"],
  ["ptype_elc_wire", "cat_electrical", "Wire / Cable"],
  ["ptype_elc_outlet", "cat_electrical", "Outlet / Switch"],
  ["ptype_elc_lighting", "cat_electrical", "Lighting"],
  ["ptype_hrd_fastener", "cat_hardware", "Fastener"],
  ["ptype_hrd_hinge", "cat_hardware", "Hinge / Bracket"],
  ["ptype_hrd_chain", "cat_hardware", "Chain / Rope"],
  ["ptype_saf_ppe", "cat_safety", "PPE"],
  ["ptype_saf_alarm", "cat_safety", "Alarm / Detector"],
] as const;

function generateProductTypes(): Doc[] {
  return PRODUCT_TYPES.map(([tid, catId, name]) => ({
    _id: tid,
    type_id: tid,
    category_id: catId,
    type_name: name,
    deleted: false,
  }));
}

/** Round-robin assignment of each product to a type within its category. */
function assignTypeIds(products: Doc[]): void {
  const byCat = new Map<string, string[]>();
  for (const [tid, catId] of PRODUCT_TYPES) {
    if (!byCat.has(catId)) byCat.set(catId, []);
    byCat.get(catId)!.push(tid);
  }
  const counters = new Map<string, number>();
  for (const p of products) {
    const types = byCat.get(p.category_id as string)!;
    const n = counters.get(p.category_id as string) ?? 0;
    p.type_id = types[n % types.length];
    counters.set(p.category_id as string, n + 1);
  }
}

/** Catalog anchors: first-day Seattle order + a customer with three orders. */
const ANCHOR_CUSTOMER_ID = "d30977d3-fa5d-4e13-9175-f637bccc4c87";

function anchorDocs(): { customer: Doc; orders: Doc[]; items: Doc[] } {
  const customer: Doc = {
    _id: ANCHOR_CUSTOMER_ID,
    customer_id: ANCHOR_CUSTOMER_ID,
    first_name: "Jordan",
    last_name: "Anchor",
    email: "jordan.anchor@example.net",
    phone: "+1-555-010-3099",
    primary_store_id: "store_seattle",
    created_at: "2022-12-01T09:00:00Z",
    deleted: false,
  };
  const orders: Doc[] = [];
  const items: Doc[] = [];
  const orderIds = ["order_20221209_0001", "order_20230110_0001", "order_20230615_0001"];
  const dates = ["2022-12-09T10:15:00Z", "2023-01-10T11:45:00Z", "2023-06-15T16:20:00Z"];
  for (let i = 0; i < 3; i++) {
    orders.push({
      _id: orderIds[i],
      order_id: orderIds[i],
      customer_id: ANCHOR_CUSTOMER_ID,
      store_id: "store_seattle",
      order_date: dates[i],
      item_count: 2,
      subtotal: 150.0,
      total: 164.25,
      status: "completed",
      deleted: false,
    });
    for (let line = 0; line < 2; line++) {
      const productId = line === 0 ? "prod_hnd_0001" : "prod_hnd_0002";
      items.push({
        _id: deterministicUuid(`joins-anchor-${orderIds[i]}-${line}`),
        order_id: orderIds[i],
        product_id: productId,
        quantity: 1,
        unit_price: 75.0,
        discount_percent: 0,
        line_total: 75.0,
        deleted: false,
      });
    }
  }
  return { customer, orders, items };
}

function strip(doc: Doc, keys: string[]): Doc {
  const out = { ...doc };
  for (const k of keys) delete out[k];
  return out;
}

function generate({ docs, rng, seed }: GenerateOptions) {
  const stores = generateStores();
  const categories = generateCategories();
  const productTypes = generateProductTypes();
  const products = generateProducts(rng);
  assignTypeIds(products);

  const customerCount = Math.max(50, Math.round(docs / 4));
  const customers = generateCustomers(stores, customerCount, rng, seed);
  const anchors = anchorDocs();

  const inventory = generateInventory(stores, products, rng, 0.08); // LEFT JOIN holes
  const { orders, items } = generateOrders(stores, products, customers, docs, rng, seed);
  // Anchor orders that collide with generated ids must own their items:
  // drop the generated items for collided order ids first.
  const anchorOrderIds = new Set(anchors.orders.map((o) => o._id as string));
  const collidedIds = new Set(orders.filter((o) => anchorOrderIds.has(o._id as string)).map((o) => o._id as string));
  const keptItems = collidedIds.size > 0 ? items.filter((i) => !collidedIds.has(i.order_id as string)) : items;
  upsertAnchors(customers, [anchors.customer]);
  upsertAnchors(orders, anchors.orders);
  upsertAnchors(keptItems, anchors.items);

  return [
    { collection: "stores", docs: stores },
    { collection: "categories", docs: categories },
    { collection: "product_types", docs: productTypes },
    { collection: "products", docs: products },
    { collection: "customers", docs: customers },
    { collection: "inventory", docs: inventory },
    // Normalized: denormalized fields stripped to force JOINs.
    { collection: "orders", docs: orders.map((o) => strip(o, ["customer_name", "customer_email", "store_name"])) },
    { collection: "order_items", docs: keptItems.map((i) => strip(i, ["store_id", "sku", "product_name"])) },
  ];
}

const suite: DatasetSuite = {
  name: "retail-joins",
  description:
    "Retail, normalized for JOINs: + product_types (32), orders/order_items stripped of denormalized fields. Ported from dql-metrics-benchmark.",
  scalingDimension: "orders",
  defaultDocs: 5_000,
  collections: [
    { name: "stores", shape: "same as retail (8 fixed)" },
    { name: "categories", shape: "same as retail (9 fixed)" },
    { name: "product_types", shape: "_id, type_id, category_id, type_name, deleted (32 fixed)" },
    { name: "products", shape: "retail products + type_id (400 fixed)" },
    { name: "customers", shape: "same as retail (~docs/4)" },
    { name: "inventory", shape: "retail inventory, ~8% pairs dropped (anti-join holes)" },
    { name: "orders", shape: "retail orders minus customer_name/customer_email/store_name" },
    { name: "order_items", shape: "retail order_items minus store_id/sku/product_name" },
  ],
  catalog: catalog as unknown as Record<string, CatalogQuery>,
  knownIssues: {
    joins__left__products_inventory_stock_value:
      "SDK 5.1.0: hangs (nlJoin over intersectScan) when the inv_store_flat index exists — run without --setup, or add LIMIT. Tracked upstream; see plans/SDKS-4855-implementation-plan.md.",
  },
  generate,
};

export default suite;
