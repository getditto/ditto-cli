import catalog from "./benchmarks.json" with { type: "json" };
import type { CatalogQuery, DatasetSuite, Doc, GenerateOptions, RngLike } from "../../src/datasets/types.js";

/**
 * pos — point-of-sale suite, faithful port of tools/gen-pos-data.py:
 * 7 fixed locations, 47 sale_items built from the verbatim 20-item catalog
 * and per-location menus (with modifier groups), and pos_orders with money
 * objects, cart modifiers, status logs, and split/refund payments.
 */

const LOCATIONS = [
  ["00001", "Ham's Burgers"],
  ["00002", "Sally's Salad Bar"],
  ["00003", "Kyle's Kabobs"],
  ["00004", "Frank's Falafels"],
  ["00005", "Cathy's Crepes"],
  ["00006", "Gilbert's Gumbo"],
  ["00007", "Tarra's Tacos"],
] as const;

/** (id, name, imageName, cents) — verbatim from demoapp-pos-kds SaleItemSeed. */
const CATALOG = [
  ["00001", "Burger", "burger", 850], ["00002", "Burrito", "burrito", 650],
  ["00003", "Fried Chicken", "chicken", 800], ["00004", "Potato Chips", "chips", 250],
  ["00005", "Coffee", "coffee", 195], ["00006", "Cookies", "cookies", 350],
  ["00007", "Corn", "corn", 350], ["00008", "French Fries", "fries", 350],
  ["00009", "Fruit Salad", "fruit_salad", 650], ["00010", "Gumbo", "gumbo", 995],
  ["00011", "Ice Cream", "ice_cream", 250], ["00012", "Milk", "milk", 200],
  ["00013", "Onion Rings", "onion_rings", 350], ["00014", "Pancakes", "pancakes", 550],
  ["00015", "Pie", "pie", 450], ["00016", "Salad", "salad", 650],
  ["00017", "Sandwich", "sandwich", 450], ["00018", "Soft Drink", "soft_drink", 150],
  ["00019", "Tacos", "tacos", 650], ["00020", "Veggie Plate", "veggies", 750],
] as const;

const MENUS: Record<string, readonly string[]> = {
  "00001": ["00001", "00008", "00013", "00018", "00012", "00011", "00006"],
  "00002": ["00016", "00009", "00020", "00017", "00018", "00005", "00012"],
  "00003": ["00003", "00017", "00016", "00020", "00018", "00005", "00006"],
  "00004": ["00017", "00016", "00020", "00009", "00018", "00005", "00015"],
  "00005": ["00014", "00009", "00005", "00012", "00011", "00015", "00006"],
  "00006": ["00010", "00017", "00007", "00018", "00012", "00015"],
  "00007": ["00019", "00002", "00007", "00018", "00003", "00011"],
};

const BUSINESS_DAYS = ["2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"] as const;
const SINGLE_STORE = "00001";

const STATUS_WEIGHTS = [["delivered", 70], ["processed", 10], ["open", 10], ["inProcess", 8], ["canceled", 2]] as const;
const CART_SIZE_WEIGHTS = [[1, 18], [2, 22], [3, 20], [4, 15], [5, 10], [6, 8], [7, 4], [8, 3]] as const;
const PAY_TYPE_WEIGHTS = [["cash", 40], ["credit", 45], ["debit", 15]] as const;
const ORDER_TYPE_WEIGHTS = [["dineIn", 45], ["takeOut", 30], ["driveThru", 25]] as const;
const MODIFIER_COUNT_WEIGHTS = [[0, 35], [1, 25], [2, 18], [3, 12], [4, 6], [5, 4]] as const;
const TAX_RATE_PCT = 10;
const STATUS_RANK = ["open", "inProcess", "processed", "delivered"] as const;

const DRINK_ITEMS = new Set(["00005", "00012", "00018"]);
const DESSERT_ITEMS = new Set(["00006", "00011", "00015"]);

function itemClass(itemId: string): "drinks" | "desserts" | "food" {
  if (DRINK_ITEMS.has(itemId)) return "drinks";
  if (DESSERT_ITEMS.has(itemId)) return "desserts";
  return "food";
}

interface ModifierGroup {
  name: string;
  required: boolean;
  maxSelections: number;
  options: readonly (readonly [string, string, number, boolean])[]; // (id, name, cents, isDefault)
}

const MODIFIER_GROUPS_BY_CLASS: Record<string, Record<string, ModifierGroup>> = {
  drinks: {
    size: {
      name: "Size", required: true, maxSelections: 1,
      options: [["50021", "Small", 0, true], ["50022", "Medium", 50, false], ["50023", "Large", 100, false]],
    },
  },
  desserts: {
    extras: {
      name: "Extras", required: false, maxSelections: 2,
      options: [["50031", "Whipped Cream", 50, false], ["50032", "Chocolate Sauce", 50, false], ["50033", "Sprinkles", 25, false]],
    },
  },
  food: {
    toppings: {
      name: "Toppings", required: false, maxSelections: 4,
      options: [["50001", "Extra Cheese", 100, false], ["50002", "Bacon", 150, false], ["50003", "Grilled Onions", 50, false], ["50004", "Lettuce", 0, true], ["50005", "Tomato", 0, true], ["50006", "Jalapeños", 75, false]],
    },
    sauces: {
      name: "Sauces", required: false, maxSelections: 2,
      options: [["50011", "Ketchup", 0, true], ["50012", "Mustard", 0, false], ["50013", "Mayo", 0, false], ["50014", "BBQ Sauce", 50, false], ["50015", "Ranch", 50, false], ["50016", "Hot Sauce", 25, false]],
    },
  },
};

const OPTION_INFO = new Map<string, { name: string; group: string; cents: number; isDefault: boolean }>();
for (const groups of Object.values(MODIFIER_GROUPS_BY_CLASS)) {
  for (const [groupKey, group] of Object.entries(groups)) {
    for (const [optId, optName, optCents, optDefault] of group.options) {
      OPTION_INFO.set(optId, { name: optName, group: groupKey, cents: optCents, isDefault: optDefault });
    }
  }
}

type CatalogRow = readonly [string, string, string, number];
const CATALOG_BY_ID: Map<string, CatalogRow> = new Map(CATALOG.map((row) => [row[0], row]));

function money(amountCents: number): Doc {
  return { amount: amountCents, currency: "usd" };
}

/** Wire-format ISO timestamp with exactly 3 fractional digits, UTC. */
function wire(ms: number): string {
  return new Date(ms).toISOString();
}

function buildLocations(): Doc[] {
  return LOCATIONS.map(([id, name]) => ({ _id: id, name }));
}

function modifierGroupsFor(itemId: string): Doc {
  const out: Doc = {};
  for (const [groupKey, group] of Object.entries(MODIFIER_GROUPS_BY_CLASS[itemClass(itemId)]!)) {
    out[groupKey] = {
      name: group.name,
      required: group.required,
      maxSelections: group.maxSelections,
      options: Object.fromEntries(
        group.options.map(([optId, optName, cents, isDefault]) => [
          optId,
          { name: optName, price: money(cents), isDefault },
        ]),
      ),
    };
  }
  return out;
}

export function buildSaleItems(): Doc[] {
  const out: Doc[] = [];
  for (const [locId] of LOCATIONS) {
    for (const itemId of MENUS[locId]!) {
      const [id, name, imageName, cents] = CATALOG_BY_ID.get(itemId)!;
      out.push({
        _id: { id, locationId: locId },
        name,
        imageName,
        price: money(cents),
        modifierGroups: modifierGroupsFor(itemId),
      });
    }
  }
  return out;
}

function modifierEntry(optId: string, status: "default" | "added" | "removed"): Doc {
  const info = OPTION_INFO.get(optId)!;
  return {
    modifierId: optId,
    name: info.name,
    group: info.group,
    status,
    portion: { name: "regular", value: 1.0, price: money(status === "default" || status === "removed" ? 0 : info.cents) },
    defaultPortion: { name: "regular", value: 1.0, price: money(0) },
  };
}

function buildLineModifiers(rng: RngLike, itemId: string): Record<string, Doc> {
  const groups = MODIFIER_GROUPS_BY_CLASS[itemClass(itemId)]!;
  const allOptions = Object.values(groups).flatMap((g) => g.options.map((o) => o[0]));
  const n = Math.min(rng.weighted(MODIFIER_COUNT_WEIGHTS), allOptions.length);

  const modifiers: Record<string, Doc> = {};
  const pool = [...allOptions];
  for (let i = 0; i < n; i++) {
    const optId = pool.splice(rng.int(0, pool.length - 1), 1)[0]!;
    const info = OPTION_INFO.get(optId)!;
    modifiers[rng.uuid()] = modifierEntry(optId, info.isDefault ? "default" : "added");
  }
  if (rng.chance(0.08)) {
    const defaults = allOptions.filter((o) => OPTION_INFO.get(o)!.isDefault);
    if (defaults.length > 0) {
      modifiers[rng.uuid()] = modifierEntry(rng.pick(defaults), "removed");
    }
  }
  return modifiers;
}

function dayBounds(businessDay: string): [number, number] {
  const [y, m, d] = businessDay.split("-").map(Number) as [number, number, number];
  return [Date.UTC(y, m - 1, d, 8, 0, 0, 0), Date.UTC(y, m - 1, d, 20, 59, 59, 999)];
}

function buildOrder(rng: RngLike, locationId: string, businessDay: string): Doc {
  const [start, end] = dayBounds(businessDay);
  const createdAt = start + rng.int(0, end - start);

  const status = rng.weighted(STATUS_WEIGHTS);

  const statusLog: Record<string, string> = {};
  let lastTs: number;
  if (status === "canceled") {
    statusLog[wire(createdAt)] = "open";
    lastTs = createdAt + rng.int(60, 300) * 1000;
    statusLog[wire(lastTs)] = "canceled";
  } else {
    const target = STATUS_RANK.indexOf(status as (typeof STATUS_RANK)[number]);
    let cursor = createdAt;
    for (let rank = 0; rank <= target; rank++) {
      if (rank > 0) cursor += rng.int(60, 300) * 1000;
      statusLog[wire(cursor)] = STATUS_RANK[rank]!;
    }
    lastTs = cursor;
  }

  const orderType = rng.weighted(ORDER_TYPE_WEIGHTS);

  const menu = MENUS[locationId]!;
  const cartSize = rng.weighted(CART_SIZE_WEIGHTS);
  const cart: Record<string, Doc> = {};
  let subtotal = 0;
  let modifierTotal = 0;
  let modifierCount = 0;
  for (let i = 0; i < cartSize; i++) {
    const itemId = rng.pick(menu);
    const [, name, imageName, cents] = CATALOG_BY_ID.get(itemId)!;
    const lineCreated = createdAt + Math.round(rng.uniform(0, 120_000));
    const modifiers = buildLineModifiers(rng, itemId);
    const lineModAmount = Object.values(modifiers).reduce(
      (s, m) => s + (((m.portion as Doc).price as Doc).amount as number),
      0,
    );
    cart[rng.uuid()] = {
      saleItemId: itemId,
      name,
      imageName,
      price: money(cents),
      qty: 1,
      unitPrice: money(cents),
      lineTotal: money(cents + lineModAmount),
      modifiers,
      createdAt: wire(lineCreated),
    };
    subtotal += cents;
    modifierTotal += lineModAmount;
    modifierCount += Object.keys(modifiers).length;
  }

  const tax = Math.floor((subtotal + modifierTotal) * TAX_RATE_PCT / 100);
  const total = subtotal + modifierTotal + tax;

  let paymentStatus: string;
  if (status === "delivered" || status === "processed") {
    paymentStatus = rng.chance(0.02) ? "refunded" : "paid";
  } else {
    paymentStatus = "unpaid";
  }

  const payments: Record<string, Doc> = {};
  if (paymentStatus === "paid" || paymentStatus === "refunded") {
    let payTs = lastTs + rng.int(5, 90) * 1000;
    if (rng.chance(0.12) && total > 1) {
      const frac = rng.uniform(0.3, 0.7);
      const first = Math.max(1, Math.min(total - 1, Math.round(total * frac)));
      for (const amt of [first, total - first]) {
        payments[rng.uuid()] = { type: rng.weighted(PAY_TYPE_WEIGHTS), amount: money(amt), status: "complete", createdAt: wire(payTs) };
        payTs += rng.int(1, 5) * 1000;
      }
    } else {
      payments[rng.uuid()] = { type: rng.weighted(PAY_TYPE_WEIGHTS), amount: money(total), status: "complete", createdAt: wire(payTs) };
    }
    if (paymentStatus === "refunded") {
      payments[rng.uuid()] = { type: "refund", amount: money(total), status: "complete", createdAt: wire(payTs + rng.int(1, 5) * 1000) };
    }
  }

  return {
    _id: { id: rng.uuid(), locationId },
    createdAt: wire(createdAt),
    businessDay,
    status,
    paymentStatus,
    orderType,
    totals: { subtotal: money(subtotal), modifierTotal: money(modifierTotal), tax: money(tax), total: money(total) },
    itemCount: cartSize,
    modifierCount,
    cart,
    payments,
    status_log: statusLog,
  };
}

/** Spread `total` across n buckets; later buckets get the remainder (matches the benchmark). */
function spread(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rem = total % n;
  return Array.from({ length: n }, (_, i) => base + (i >= n - rem ? 1 : 0));
}

/** Catalog anchors: the two order ids referenced by pos `select__by_id` queries. */
const ANCHOR_IDS = ["ce5a37a2-deaf-4254-b9da-d80505801d75", "376af023-9a9d-4c49-bcad-cf0c67717141"] as const;

function generate({ docs, rng }: GenerateOptions) {
  const locations = buildLocations();
  const saleItems = buildSaleItems();

  // 50% of orders at the demo location 00001 (matches catalog emphasis),
  // the rest spread over the other six locations and four business days.
  const atSingle = Math.floor(docs / 2);
  const elsewhere = spread(docs - atSingle, LOCATIONS.length - 1);

  const orders: Doc[] = [];
  const buildFor = (locId: string, count: number) => {
    for (const [dayIdx, dayCount] of spread(count, BUSINESS_DAYS.length).entries()) {
      for (let i = 0; i < dayCount; i++) {
        orders.push(buildOrder(rng, locId, BUSINESS_DAYS[dayIdx]!));
      }
    }
  };
  buildFor(SINGLE_STORE, atSingle);
  LOCATIONS.slice(1).forEach(([locId], i) => buildFor(locId, elsewhere[i]!));

  // Anchor the two catalog-referenced order ids (location 00001, day 1).
  for (let i = 0; i < Math.min(ANCHOR_IDS.length, orders.length); i++) {
    const order = orders[i]!;
    (order._id as Doc).id = ANCHOR_IDS[i];
    (order._id as Doc).locationId = SINGLE_STORE;
    order.businessDay = BUSINESS_DAYS[0];
  }

  return [
    { collection: "locations", docs: locations },
    { collection: "sale_items", docs: saleItems },
    { collection: "pos_orders", docs: orders },
  ];
}

const suite: DatasetSuite = {
  name: "pos",
  description:
    "Point-of-sale (DittoPOS-style): 7 locations, 47 menu items with modifier groups, and orders with money objects, cart modifiers, status logs, split/refund payments. Ported from dql-metrics-benchmark.",
  scalingDimension: "orders",
  defaultDocs: 5_000,
  collections: [
    { name: "locations", shape: "_id (00001–00007), name (7 fixed)" },
    { name: "sale_items", shape: "_id {id,locationId}, name, imageName, price{amount,currency}, modifierGroups{…} (47 fixed)" },
    { name: "pos_orders", shape: "_id {id,locationId}, createdAt, businessDay, status, paymentStatus, orderType, totals{subtotal,modifierTotal,tax,total} (money objects, cents), itemCount, modifierCount, cart{…}, payments{…}, status_log{…}" },
  ],
  setupStatements: [
    "CREATE INDEX pos_loc ON pos_orders (_id.locationId)",
    "CREATE INDEX pos_loc_created ON pos_orders (_id.locationId, createdAt)",
    "CREATE INDEX pos_loc_status ON pos_orders (_id.locationId, status)",
    "CREATE INDEX pos_bday ON pos_orders (businessDay)",
    "CREATE INDEX pos_sale_loc ON sale_items (_id.locationId)",
  ],
  catalog: catalog as unknown as Record<string, CatalogQuery>,
  generate,
};

export default suite;
