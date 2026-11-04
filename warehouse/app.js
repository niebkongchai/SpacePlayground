// Warehouse: a browser-only WMS for scrapped units waiting for their next process. See REQUIREMENTS.md for the rules this file implements.
"use strict";

// ===== Constants =====
const DB_NAME = "spaceplayground-warehouse";
const SCHEMA_VERSION = 1;
const STORES = {
  skus: "code", locations: "code", asns: "noticeNo", stock: "id", serials: "key",
  orders: "no", allocs: "id", freezes: "id", history: "id", meta: "key",
};
const EXTERNAL_CODES = new Set(["357", "380"]);
const LOC_TYPES = ["Receiving", "Storage", "Outbound Staging"];
const SCRAP_REASONS = ["Damaged", "Failed test", "Obsolete", "Expired", "Rework reject"];
const ADJUST_REASONS = ["Damaged", "Lost", "Found", "Data correction", "Other"];
const FREEZE_TYPES = { SKU: "SKU", LOCATION: "Location", LOT: "Lot", LPN: "LPN" };
const HISTORY_TYPES = [
  "RECEIVE", "PUTAWAY", "MOVE", "ALLOCATE", "DEALLOCATE", "PICK", "SHIP", "ADJUST", "COUNT",
  "FREEZE", "UNFREEZE", "ASN_CREATE", "ASN_CLOSE", "ORDER_CREATE", "ORDER_CANCEL",
  "SKU_CREATE", "SKU_UPDATE", "SKU_DEACTIVATE", "SKU_ACTIVATE", "SKU_DELETE",
  "LOC_CREATE", "LOC_UPDATE", "LOC_DEACTIVATE", "LOC_ACTIVATE", "LOC_DELETE",
];
const ROW_LIMIT = 300;
const BACKUP_REMINDER_DAYS = 7;

// Run Coach order, with a purple in place of its grey (too low in chroma for a series).
const ACTIVITY = [
  { type: "RECEIVE", label: "Received", color: "#3987e5" },
  { type: "PUTAWAY", label: "Put away", color: "#d95926" },
  { type: "MOVE", label: "Moved", color: "#199e70" },
  { type: "PICK", label: "Picked", color: "#c98500" },
  { type: "SHIP", label: "Shipped", color: "#a06ee0" },
];

const MENU = [
  ["Overview", [["/", "Dashboard"]]],
  ["Master Data", [["/skus", "SKUs"], ["/locations", "Locations"]]],
  ["Inbound", [["/asns", "ASNs"], ["/receive", "Receive"], ["/putaway", "Putaway"]]],
  ["Inventory", [["/stock", "Stock Search"], ["/location", "Location View"], ["/move", "Move"],
    ["/adjust", "Adjust"], ["/count", "Cycle Count"], ["/freeze", "Freeze"]]],
  ["Outbound", [["/orders", "Orders"], ["/allocate", "Allocate"], ["/pick", "Pick"], ["/ship", "Ship"]]],
  ["Analysis", [["/reports", "Reports"], ["/history", "History"]]],
  ["System", [["/settings", "Settings"]]],
];

// ===== Small helpers =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// Template tag: every interpolated value is escaped unless it came from another h`` call.
class Raw { constructor(s) { this.s = s; } }
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
function show(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(show).join("");
  if (v === false || v === null || v === undefined) return "";
  return esc(v);
}
function h(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += show(v) + strings[i + 1]; });
  return new Raw(out);
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
let clock = null; // demo data runs on a fixed past date
const now = () => (clock ? new Date(clock) : new Date());
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => localDay(now());
const dayOf = (iso) => localDay(new Date(iso));
const fmt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtNum = (n) => Number(n || 0).toLocaleString("en-US");
const clean = (v) => String(v ?? "").trim();
const splitList = (v) => clean(v).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

function link(path, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== "" && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `#${path}${qs ? `?${qs}` : ""}`;
}

function wholeQty(v, label = "Quantity", min = 1) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) fail(`${label} must be a whole number of ${min} or more.`);
  return n;
}

// ===== Data layer =====
const S = Object.fromEntries(Object.keys(STORES).map((k) => [k, new Map()]));
let idb = null;
let operator = "";
try { operator = localStorage.getItem("wh-operator") || ""; } catch { /* storage blocked */ }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = () => {
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadAll() {
  const names = Object.keys(STORES);
  const tx = idb.transaction(names, "readonly");
  await Promise.all(names.map((name) => new Promise((resolve, reject) => {
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => {
      S[name] = new Map(req.result.map((r) => [r[STORES[name]], r]));
      resolve();
    };
    req.onerror = () => reject(req.error);
  })));
}

// One business action = one Tx. Changes apply to memory at once so later steps of the same
// action see them, then go to IndexedDB in a single transaction. Any failure undoes them all.
class Tx {
  constructor() { this.ops = []; this.undo = []; this.operator = operator; }

  put(store, rec) {
    const key = rec[STORES[store]];
    this.undo.push([store, key, S[store].get(key)]);
    S[store].set(key, rec);
    this.ops.push([store, "put", rec]);
  }

  del(store, key) {
    this.undo.push([store, key, S[store].get(key)]);
    S[store].delete(key);
    this.ops.push([store, "delete", key]);
  }

  seq(name) {
    const cur = S.meta.get("seq") || { key: "seq" };
    const next = (cur[name] || 0) + 1;
    this.put("meta", { ...cur, [name]: next });
    return next;
  }

  commit() {
    if (!this.ops.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stores = [...new Set(this.ops.map((o) => o[0]))];
      const tx = idb.transaction(stores, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      for (const [store, kind, arg] of this.ops) tx.objectStore(store)[kind](arg);
    });
  }

  rollback() {
    for (const [store, key, prev] of this.undo.reverse()) {
      if (prev === undefined) S[store].delete(key);
      else S[store].set(key, prev);
    }
  }
}

let queue = Promise.resolve();
function act(fn, { system = false } = {}) {
  const run = async () => {
    if (!system && !operator) fail("Enter your operator name at the top of the page first.");
    const t = new Tx();
    try {
      const result = fn(t);
      await t.commit();
      return result;
    } catch (e) {
      t.rollback();
      throw e;
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function log(t, type, fields = {}) {
  t.put("history", {
    id: t.seq("history"), at: now().toISOString(), operator: t.operator, type,
    sku: "", lot: "", expiry: "", serials: [], lpn: "", noticeNo: "", orderType: "", scrapReason: "",
    fromLoc: "", toLoc: "", qty: 0, delta: 0, ref: "", reason: "", ...fields,
  });
}

// ===== Lookups =====
const stockRows = () => [...S.stock.values()];
const skuOf = (code) => S.skus.get(code);
const dims = (s) => ({ sku: s.sku, loc: s.loc, lot: s.lot, expiry: s.expiry, lpn: s.lpn, noticeNo: s.noticeNo, scrapReason: s.scrapReason });
const stockFields = (s) => ({ sku: s.sku, lot: s.lot, expiry: s.expiry, lpn: s.lpn, noticeNo: s.noticeNo, scrapReason: s.scrapReason });
const lotKey = (sku, lot) => `${sku}|${lot}`;
const serialKey = (sku, serial) => `${sku}|${serial}`;
const orderAllocs = (no) => [...S.allocs.values()].filter((a) => a.orderNo === no);
const isExpired = (s) => !!s.expiry && s.expiry < today();
const waitingDays = (s) => Math.max(Math.floor((now() - new Date(s.receivedAt)) / 86400000), 0);
const orderTypeOf = (code) => (EXTERNAL_CODES.has(clean(code)) ? "External" : "Internal");

function resolveSku(text) {
  const v = clean(text);
  if (S.skus.has(v)) return S.skus.get(v);
  return [...S.skus.values()].find((s) => s.barcode && s.barcode === v);
}
function needSku(text) { return resolveSku(text) || fail(`SKU "${clean(text)}" does not exist.`); }

function needLoc(code, type) {
  const loc = S.locations.get(clean(code));
  if (!loc) fail(`Location "${clean(code)}" does not exist.`);
  if (!loc.active) fail(`Location ${loc.code} is inactive.`);
  if (type && loc.type !== type) fail(`Location ${loc.code} is not a ${type} location.`);
  return loc;
}
const needStock = (id) => S.stock.get(Number(id)) || fail("That stock record no longer exists.");
const needOrder = (no) => S.orders.get(no) || fail(`Order ${no} does not exist.`);

function serialIndex() {
  const idx = new Map();
  for (const s of S.serials.values()) {
    if (s.status !== "IN_STOCK") continue;
    if (!idx.has(s.stockId)) idx.set(s.stockId, []);
    idx.get(s.stockId).push(s);
  }
  return idx;
}
const serialsOf = (stockId) => [...S.serials.values()].filter((s) => s.stockId === stockId && s.status === "IN_STOCK");
const freeSerials = (stockId) => serialsOf(stockId).filter((s) => !s.allocId);

// ===== Freeze =====
const activeFreezes = () => [...S.freezes.values()].filter((f) => !f.releasedAt);

function freezesOn({ sku, loc, lot, lpn }) {
  return activeFreezes().filter((f) => (
    (f.type === "SKU" && f.target === sku)
    || (f.type === "LOCATION" && f.target === loc)
    || (f.type === "LPN" && !!lpn && f.target === lpn)
    || (f.type === "LOT" && !!lot && f.target === lotKey(sku, lot))
  ));
}
const isFrozen = (d) => freezesOn(d).length > 0;
const freezeLabel = (f) => `${FREEZE_TYPES[f.type]} ${f.type === "LOT" ? f.target.replace("|", " / ") : f.target}`;

function assertNotFrozen(d, action) {
  const f = freezesOn(d)[0];
  if (f) fail(`Cannot ${action}: ${freezeLabel(f)} is frozen. Reason: ${f.reason} (by ${f.by}).`);
}

const availableOf = (s) => (isFrozen(s) ? 0 : s.qty - s.allocatedQty);

// ===== Stock primitives =====
function findStock(d) {
  return stockRows().find((s) => s.sku === d.sku && s.loc === d.loc && s.lot === d.lot
    && s.expiry === d.expiry && s.lpn === d.lpn && s.noticeNo === d.noticeNo && s.scrapReason === d.scrapReason);
}

// receivedAt starts the waiting time. It survives moves, and merged stock keeps the oldest date.
function addQty(t, d, qty, allocated = 0, receivedAt = now().toISOString()) {
  const cur = findStock(d);
  const rec = cur
    ? {
      ...cur, qty: cur.qty + qty, allocatedQty: cur.allocatedQty + allocated,
      receivedAt: cur.receivedAt < receivedAt ? cur.receivedAt : receivedAt,
    }
    : { id: t.seq("stock"), ...d, qty, allocatedQty: allocated, receivedAt };
  t.put("stock", rec);
  return rec;
}

function takeQty(t, stockId, qty, allocated = 0) {
  const cur = S.stock.get(stockId);
  const left = cur.qty - qty;
  const leftAlloc = cur.allocatedQty - allocated;
  if (left < 0 || leftAlloc < 0 || leftAlloc > left) fail("That would make a quantity negative.");
  if (left === 0) t.del("stock", stockId);
  else t.put("stock", { ...cur, qty: left, allocatedQty: leftAlloc });
}

function checkLpnAt(lpn, loc) {
  if (!lpn) return;
  const other = stockRows().find((s) => s.lpn === lpn && s.loc !== loc);
  if (other) fail(`LPN ${lpn} is in location ${other.loc}. An LPN sits in one location.`);
}

function validateTracking(sku, lot, expiry) {
  if (sku.lotControlled && !lot) fail(`SKU ${sku.code} needs a lot number.`);
  if (sku.expiryControlled && !expiry) fail(`SKU ${sku.code} needs an expiry date.`);
  return { lot: sku.lotControlled ? lot : "", expiry: sku.expiryControlled ? expiry : "" };
}

function registerSerials(t, sku, list, stockId) {
  if (new Set(list).size !== list.length) fail("The same serial was entered twice.");
  for (const serial of list) {
    const cur = S.serials.get(serialKey(sku.code, serial));
    if (cur?.status === "IN_STOCK") fail(`Serial ${serial} is already in stock at ${S.stock.get(cur.stockId)?.loc}.`);
    if (cur?.status === "SHIPPED") fail(`Serial ${serial} already shipped on order ${cur.orderNo}. Returns are not supported.`);
    t.put("serials", {
      key: serialKey(sku.code, serial), sku: sku.code, serial, stockId, status: "IN_STOCK",
      allocId: null, orderNo: "", shippedAt: "",
    });
  }
}

// Which serials a quantity of a stock record covers. Partial quantities must name them.
function chooseSerials(s, qty, chosen) {
  if (!skuOf(s.sku).serialControlled) return [];
  const free = freeSerials(s.id);
  if (!chosen?.length && qty === free.length) return free.map((x) => x.serial);
  if ((chosen?.length || 0) !== qty) fail(`Choose exactly ${qty} serial(s).`);
  const ok = new Set(free.map((x) => x.serial));
  for (const serial of chosen) if (!ok.has(serial)) fail(`Serial ${serial} is not available in this stock record.`);
  return chosen;
}

function setSerials(t, sku, list, change) {
  for (const serial of list) {
    const key = serialKey(sku, serial);
    t.put("serials", { ...S.serials.get(key), ...change });
  }
}

function transfer(t, s, qty, to, serials) {
  takeQty(t, s.id, qty);
  const dest = addQty(t, { ...dims(s), ...to }, qty, 0, s.receivedAt);
  setSerials(t, s.sku, serials, { stockId: dest.id });
  return dest;
}

function nextLpn(t) { return `LPN-${pad(t.seq("lpn"), 6)}`; }

// ===== Operations =====
const op = {
  saveSku(t, form, originalCode) {
    const code = clean(form.code);
    if (!code) fail("SKU code is required.");
    if (!clean(form.description)) fail("Description is required.");
    const barcode = clean(form.barcode);
    if (barcode) {
      const clash = [...S.skus.values()].find((s) => s.barcode === barcode && s.code !== originalCode);
      if (clash) fail(`Barcode ${barcode} is already used by SKU ${clash.code}.`);
    }
    const old = originalCode ? skuOf(originalCode) : null;
    if (code !== originalCode && S.skus.has(code)) fail(`SKU ${code} already exists.`);
    const rec = {
      code, description: clean(form.description), category: clean(form.category),
      uom: clean(form.uom) || "EA", barcode,
      lotControlled: !!form.lotControlled, expiryControlled: !!form.expiryControlled,
      serialControlled: !!form.serialControlled, active: old ? old.active : true,
    };
    if (old && skuInUse(old.code)) {
      if (code !== old.code) fail("SKU code cannot change after first use.");
      for (const k of ["lotControlled", "expiryControlled", "serialControlled"]) {
        if (rec[k] !== old[k]) fail("Tracking settings cannot change once the SKU has stock or history.");
      }
    }
    if (old && code !== old.code) t.del("skus", old.code);
    t.put("skus", rec);
    log(t, old ? "SKU_UPDATE" : "SKU_CREATE", { sku: code, ref: old?.code || "" });
    return rec;
  },

  setSkuActive(t, code, active) {
    t.put("skus", { ...skuOf(code), active });
    log(t, active ? "SKU_ACTIVATE" : "SKU_DEACTIVATE", { sku: code });
  },

  deleteSku(t, code) {
    if (skuInUse(code)) fail("A SKU with stock or history cannot be deleted. Deactivate it instead.");
    t.del("skus", code);
    log(t, "SKU_DELETE", { sku: code });
  },

  addLocation(t, form) {
    const zone = clean(form.zone).toUpperCase();
    if (!zone) fail("Zone is required.");
    const [aisle, rack, bin] = [form.aisle, form.rack, form.bin].map((v) => wholeQty(v, "Aisle, rack and bin"));
    const code = `${zone}-${pad(aisle)}-${pad(rack)}-${pad(bin)}`;
    if (S.locations.has(code)) fail(`Location ${code} already exists.`);
    if (!LOC_TYPES.includes(form.type)) fail("Choose a location type.");
    t.put("locations", { code, zone, aisle, rack, bin, type: form.type, active: true });
    log(t, "LOC_CREATE", { toLoc: code });
    return code;
  },

  bulkLocations(t, form) {
    const range = (a, b, label) => {
      const from = wholeQty(a, label);
      const to = wholeQty(b, label);
      if (to < from) fail(`${label}: the end must not be below the start.`);
      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    };
    const aisles = range(form.aisleFrom, form.aisleTo, "Aisle");
    const racks = range(form.rackFrom, form.rackTo, "Rack");
    const bins = range(form.binFrom, form.binTo, "Bin");
    if (aisles.length * racks.length * bins.length > 1000) fail("That is over 1,000 locations. Use a smaller range.");
    let added = 0;
    let skipped = 0;
    for (const aisle of aisles) for (const rack of racks) for (const bin of bins) {
      const code = `${clean(form.zone).toUpperCase()}-${pad(aisle)}-${pad(rack)}-${pad(bin)}`;
      if (S.locations.has(code)) { skipped += 1; continue; }
      op.addLocation(t, { zone: form.zone, aisle, rack, bin, type: form.type });
      added += 1;
    }
    return { added, skipped };
  },

  setLocationType(t, code, type) {
    if (locationHasStock(code)) fail("Empty the location before changing its type.");
    t.put("locations", { ...S.locations.get(code), type });
    log(t, "LOC_UPDATE", { toLoc: code, reason: `Type set to ${type}` });
  },

  setLocationActive(t, code, active) {
    if (!active && locationHasStock(code)) fail("Only an empty location can be deactivated.");
    t.put("locations", { ...S.locations.get(code), active });
    log(t, active ? "LOC_ACTIVATE" : "LOC_DEACTIVATE", { toLoc: code });
  },

  deleteLocation(t, code) {
    if (locationInUse(code)) fail("A location with stock or history cannot be deleted. Deactivate it instead.");
    t.del("locations", code);
    log(t, "LOC_DELETE", { toLoc: code });
  },

  createAsn(t, form) {
    const noticeNo = clean(form.noticeNo);
    const internalOrder = clean(form.internalOrder);
    if (!noticeNo) fail("Notice No. is required.");
    if (S.asns.has(noticeNo)) fail(`Notice No. ${noticeNo} already exists. A Notice No. must be unique.`);
    if (!internalOrder) fail("Internal Order is required.");
    if (!form.when) fail("When is required.");
    if (!clean(form.who)) fail("Who is required.");
    if (!clean(form.scrapReason)) fail("Scrap reason is required.");
    const sku = needSku(form.sku);
    if (!sku.active) fail(`SKU ${sku.code} is inactive.`);
    const rec = {
      noticeNo, internalOrder, orderType: orderTypeOf(internalOrder), sku: sku.code,
      qty: wholeQty(form.qty), when: new Date(form.when).toISOString(), who: clean(form.who),
      lot: clean(form.lot), expiry: clean(form.expiry), scrapReason: clean(form.scrapReason),
      receivedQty: 0, shortQty: 0, status: "Open", createdAt: now().toISOString(), createdBy: t.operator,
    };
    t.put("asns", rec);
    log(t, "ASN_CREATE", {
      sku: sku.code, noticeNo, orderType: rec.orderType, scrapReason: rec.scrapReason, qty: rec.qty, ref: internalOrder,
    });
    return rec;
  },

  closeAsn(t, noticeNo) {
    const asn = S.asns.get(noticeNo);
    if (!asn || asn.status === "Closed") fail("This ASN is already closed.");
    const shortQty = Math.max(asn.qty - asn.receivedQty, 0);
    t.put("asns", { ...asn, status: "Closed", shortQty });
    log(t, "ASN_CLOSE", {
      sku: asn.sku, noticeNo, orderType: asn.orderType, qty: shortQty, reason: `Closed short by ${shortQty}`,
    });
  },

  receive(t, form) {
    const asn = form.asn ? S.asns.get(form.asn) : null;
    if (form.asn && !asn) fail(`ASN ${form.asn} does not exist.`);
    if (asn?.status === "Closed") fail(`ASN ${asn.noticeNo} is closed.`);
    const blindNotice = clean(form.blindNotice);
    if (!asn && S.asns.has(blindNotice)) fail(`Notice No. ${blindNotice} has an ASN. Receive against that ASN.`);

    const sku = needSku(asn ? asn.sku : form.sku);
    if (!sku.active) fail(`SKU ${sku.code} is inactive.`);
    const qty = wholeQty(form.qty);
    const loc = needLoc(form.loc, "Receiving");
    const { lot, expiry } = validateTracking(sku, clean(form.lot), clean(form.expiry));
    const serials = sku.serialControlled ? form.serials || [] : [];
    if (sku.serialControlled && serials.length !== qty) fail(`Enter ${qty} serial(s). You entered ${serials.length}.`);

    let lpn = clean(form.lpn);
    if (lpn) checkLpnAt(lpn, loc.code);
    assertNotFrozen({ sku: sku.code, loc: loc.code, lot, lpn }, "receive");
    if (form.newLpn) lpn = nextLpn(t);

    const noticeNo = asn ? asn.noticeNo : blindNotice;
    const scrapReason = asn ? asn.scrapReason : clean(form.scrapReason);
    let reason = asn ? "" : "Blind receipt";
    if (asn) {
      const total = asn.receivedQty + qty;
      const over = total - asn.qty;
      if (over > 0) {
        if (!form.confirmOver) fail(`This is ${over} more than expected. Confirm the over-receipt first.`);
        reason = `Over-receipt by ${over}`;
      }
      t.put("asns", { ...asn, receivedQty: total, status: total >= asn.qty ? "Closed" : "Partially Received" });
    }
    const rec = addQty(t, { sku: sku.code, loc: loc.code, lot, expiry, lpn, noticeNo, scrapReason }, qty);
    registerSerials(t, sku, serials, rec.id);
    log(t, "RECEIVE", {
      sku: sku.code, lot, expiry, serials, lpn, noticeNo, scrapReason, orderType: asn?.orderType || "",
      toLoc: loc.code, qty, delta: qty, ref: asn?.internalOrder || "", reason,
    });
    return rec;
  },

  move(t, { stockId, qty, toLoc, toLpn, serials, type = "MOVE" }) {
    const s = needStock(stockId);
    const n = wholeQty(qty);
    if (n > s.qty - s.allocatedQty) fail(`Only ${s.qty - s.allocatedQty} can move. The rest is allocated.`);
    const dest = needLoc(toLoc, type === "PUTAWAY" ? "Storage" : undefined);
    const lpn = clean(toLpn);
    assertNotFrozen(s, "move this stock");
    assertNotFrozen({ ...s, loc: dest.code, lpn }, "move into the destination");
    if (dest.code === s.loc && lpn === s.lpn) fail("The stock is already there.");
    checkLpnAt(lpn, dest.code);
    const list = chooseSerials(s, n, serials);
    transfer(t, s, n, { loc: dest.code, lpn }, list);
    log(t, type, {
      ...stockFields(s), lpn: lpn || s.lpn, serials: list, fromLoc: s.loc, toLoc: dest.code, qty: n,
      reason: lpn !== s.lpn ? `LPN ${s.lpn || "none"} to ${lpn || "none"}` : "",
    });
  },

  moveLpn(t, { lpn, toLoc, type = "MOVE" }) {
    const rows = stockRows().filter((s) => s.lpn === clean(lpn));
    if (!rows.length) fail(`LPN ${clean(lpn)} has no stock.`);
    for (const s of rows) assertNotFrozen(s, "move this LPN");
    if (rows.some((s) => s.allocatedQty > 0)) fail(`LPN ${clean(lpn)} holds allocated stock, so it cannot move as a whole.`);
    const dest = needLoc(toLoc, type === "PUTAWAY" ? "Storage" : undefined);
    if (rows[0].loc === dest.code) fail("The LPN is already there.");
    const ref = `LPN move ${clean(lpn)}`;
    for (const s of rows) {
      assertNotFrozen({ ...s, loc: dest.code }, "move into the destination");
      const list = serialsOf(s.id).map((x) => x.serial);
      transfer(t, s, s.qty, { loc: dest.code }, list);
      log(t, type, { ...stockFields(s), serials: list, fromLoc: s.loc, toLoc: dest.code, qty: s.qty, ref });
    }
  },

  createOrder(t, form) {
    const no = clean(form.no) || `SO-${pad(t.seq("order"), 4)}`;
    if (S.orders.has(no)) fail(`Order ${no} already exists.`);
    if (!clean(form.nextProcess)) fail("Next process is required.");
    if (!form.lines?.length) fail("Add at least one line.");
    const lines = form.lines.map((l, i) => {
      const sku = needSku(l.sku);
      if (!sku.active) fail(`SKU ${sku.code} is inactive.`);
      return { lineNo: i + 1, sku: sku.code, qty: wholeQty(l.qty), shippedQty: 0, shortQty: 0 };
    });
    t.put("orders", {
      no, nextProcess: clean(form.nextProcess), shipDate: clean(form.shipDate), lines, status: "Draft",
      shipped: [], createdAt: now().toISOString(), createdBy: t.operator, shippedAt: "",
    });
    log(t, "ORDER_CREATE", { ref: no, qty: lines.reduce((a, l) => a + l.qty, 0) });
    return no;
  },

  allocate(t, { no, lineNo, stockId, qty, serials, confirmExpired }) {
    const o = needOrder(no);
    if (!["Draft", "Allocated"].includes(o.status)) fail(`Order ${no} is ${o.status}.`);
    const line = o.lines.find((l) => l.lineNo === lineNo) || fail("That order line does not exist.");
    const s = needStock(stockId);
    if (s.sku !== line.sku) fail("That stock is a different SKU.");
    assertNotFrozen(s, "allocate");
    if (S.locations.get(s.loc).type !== "Storage") fail("Allocate from Storage locations only.");
    const n = wholeQty(qty);
    const open = line.qty - lineAllocated(no, lineNo);
    if (n > open) fail(`Only ${open} still needs allocating on this line.`);
    if (n > s.qty - s.allocatedQty) fail(`Only ${s.qty - s.allocatedQty} is available in this record.`);
    if (isExpired(s) && !confirmExpired) fail("This stock has expired. Confirm first.");
    const list = chooseSerials(s, n, serials);
    const id = t.seq("alloc");
    t.put("stock", { ...S.stock.get(s.id), allocatedQty: s.allocatedQty + n });
    setSerials(t, s.sku, list, { allocId: id });
    t.put("allocs", {
      id, orderNo: no, lineNo, stockId: s.id, ...stockFields(s), fromLoc: s.loc, qty: n, serials: list, status: "ALLOCATED",
    });
    log(t, "ALLOCATE", {
      ...stockFields(s), serials: list, fromLoc: s.loc, qty: n, ref: no,
      reason: isExpired(s) ? "Expired stock confirmed" : "",
    });
    refreshOrderStatus(t, no);
  },

  deallocate(t, allocId) {
    const a = S.allocs.get(allocId) || fail("That allocation no longer exists.");
    if (a.status !== "ALLOCATED") fail("Picked stock cannot be deallocated.");
    releaseAlloc(t, a, a.qty, a.serials, "Deallocated");
    refreshOrderStatus(t, a.orderNo);
  },

  cancelOrder(t, no) {
    const o = needOrder(no);
    if (["Shipped", "Cancelled"].includes(o.status)) fail(`Order ${no} is ${o.status}.`);
    for (const a of orderAllocs(no)) releaseAlloc(t, a, a.qty, a.serials, "Order cancelled");
    t.put("orders", { ...S.orders.get(no), status: "Cancelled" });
    log(t, "ORDER_CANCEL", { ref: no });
  },

  pick(t, { no, picks, stagingLoc }) {
    const o = needOrder(no);
    if (o.status !== "Allocated") fail(`Order ${no} must be fully allocated before picking.`);
    const staging = needLoc(stagingLoc, "Outbound Staging");
    const allocs = orderAllocs(no);
    const wanted = new Map(allocs.map((a) => {
      const p = picks.find((x) => x.allocId === a.id);
      const qty = p ? wholeQty(p.qty, "Picked quantity", 0) : a.qty;
      if (qty > a.qty) fail(`You cannot pick more than the ${a.qty} allocated.`);
      return [a.id, { qty, serials: p?.serials }];
    }));
    if (![...wanted.values()].some((p) => p.qty > 0)) fail("Nothing to pick. Deallocate or cancel the order instead.");

    for (const a of allocs) {
      const s = S.stock.get(a.stockId);
      assertNotFrozen(s, "pick");
      assertNotFrozen({ ...s, loc: staging.code, lpn: "" }, "pick into the staging location");
    }
    for (const a of allocs) {
      const { qty, serials } = wanted.get(a.id);
      let keep = a.serials;
      if (a.serials.length && qty < a.qty) {
        keep = serials || [];
        if (keep.length !== qty) fail(`Choose exactly ${qty} serial(s) for ${a.sku}.`);
      }
      if (qty < a.qty) {
        const dropped = a.serials.filter((x) => !keep.includes(x));
        releaseAlloc(t, a, a.qty - qty, dropped, "Short pick");
      }
      if (qty === 0) continue;
      const s = S.stock.get(a.stockId);
      takeQty(t, s.id, qty, qty);
      // Picked stock leaves its LPN, because an LPN stays in one location.
      const dest = addQty(t, { ...dims(s), loc: staging.code, lpn: "" }, qty, qty, s.receivedAt);
      setSerials(t, a.sku, keep, { stockId: dest.id });
      t.put("allocs", { ...a, qty, serials: keep, stockId: dest.id, status: "PICKED" });
      log(t, "PICK", { ...stockFields(a), serials: keep, fromLoc: a.fromLoc, toLoc: staging.code, qty, ref: no });
    }
    t.put("orders", { ...S.orders.get(no), status: "Picked" });
  },

  ship(t, no) {
    const o = needOrder(no);
    if (o.status !== "Picked") fail(`Order ${no} must be picked before shipping.`);
    const allocs = orderAllocs(no);
    for (const a of allocs) assertNotFrozen(S.stock.get(a.stockId), "ship");
    const shippedAt = now().toISOString();
    const lines = o.lines.map((l) => ({ ...l }));
    const shipped = [];
    for (const a of allocs) {
      const s = S.stock.get(a.stockId);
      takeQty(t, s.id, a.qty, a.qty);
      setSerials(t, a.sku, a.serials, { status: "SHIPPED", stockId: null, allocId: null, orderNo: no, shippedAt });
      lines.find((l) => l.lineNo === a.lineNo).shippedQty += a.qty;
      shipped.push({ ...stockFields(a), lineNo: a.lineNo, qty: a.qty, serials: a.serials });
      t.del("allocs", a.id);
    }
    for (const l of lines) l.shortQty = l.qty - l.shippedQty;
    for (const a of shipped) {
      const short = lines.find((l) => l.lineNo === a.lineNo).shortQty;
      log(t, "SHIP", {
        ...a, lineNo: undefined, fromLoc: "", qty: a.qty, delta: -a.qty, ref: no,
        reason: short ? `Line shipped short by ${short}` : "",
      });
    }
    t.put("orders", { ...o, lines, shipped, shippedAt, status: "Shipped" });
  },

  adjust(t, { stockId, newQty, remove, add, reasonCode, note }) {
    if (!ADJUST_REASONS.includes(reasonCode)) fail("Choose a reason code.");
    const s = needStock(stockId);
    const changed = applyQtyChange(t, s, "ADJUST", { newQty, remove, add, reason: [reasonCode, clean(note)].filter(Boolean).join(": ") });
    if (!changed) fail("Nothing changed.");
  },

  postCount(t, { lines, found }) {
    let posted = 0;
    for (const l of lines) {
      const s = needStock(l.stockId);
      posted += applyQtyChange(t, s, "COUNT", { ...l, reason: "Cycle count" }) ? 1 : 0;
    }
    for (const f of found) {
      const sku = needSku(f.sku);
      const loc = needLoc(f.loc);
      const qty = wholeQty(f.qty);
      const { lot, expiry } = validateTracking(sku, clean(f.lot), clean(f.expiry));
      const lpn = clean(f.lpn);
      const serials = sku.serialControlled ? f.serials || [] : [];
      if (sku.serialControlled && serials.length !== qty) fail(`Enter ${qty} serial(s) for found SKU ${sku.code}.`);
      assertNotFrozen({ sku: sku.code, loc: loc.code, lot, lpn }, "count");
      checkLpnAt(lpn, loc.code);
      const rec = addQty(t, { sku: sku.code, loc: loc.code, lot, expiry, lpn, noticeNo: "", scrapReason: "" }, qty);
      registerSerials(t, sku, serials, rec.id);
      log(t, "COUNT", { sku: sku.code, lot, expiry, lpn, serials, toLoc: loc.code, qty, delta: qty, reason: "Cycle count: found" });
      posted += 1;
    }
    return posted;
  },

  freeze(t, { type, target, sku, reason }) {
    if (!FREEZE_TYPES[type]) fail("Choose what to freeze.");
    const why = clean(reason);
    if (!why) fail("A freeze needs a reason.");
    let key = clean(target);
    if (!key) fail("Enter what to freeze.");
    if (type === "SKU") key = needSku(key).code;
    if (type === "LOCATION" && !S.locations.has(key)) fail(`Location ${key} does not exist.`);
    if (type === "LPN" && !stockRows().some((s) => s.lpn === key)) fail(`LPN ${key} has no stock.`);
    if (type === "LOT") {
      const code = needSku(sku).code;
      if (!stockRows().some((s) => s.sku === code && s.lot === key)) fail(`SKU ${code} has no stock in lot ${key}.`);
      key = lotKey(code, key);
    }
    if (activeFreezes().some((f) => f.type === type && f.target === key)) fail("That is already frozen.");
    const rec = {
      id: t.seq("freeze"), type, target: key, reason: why, by: t.operator, at: now().toISOString(),
      releasedBy: "", releasedAt: "",
    };
    t.put("freezes", rec);
    log(t, "FREEZE", { ...freezeHistory(rec), reason: why });
  },

  unfreeze(t, id) {
    const f = S.freezes.get(id);
    if (!f || f.releasedAt) fail("That freeze is already released.");
    const rec = { ...f, releasedBy: t.operator, releasedAt: now().toISOString() };
    t.put("freezes", rec);
    log(t, "UNFREEZE", { ...freezeHistory(rec), reason: f.reason });
  },
};

function freezeHistory(f) {
  if (f.type === "SKU") return { sku: f.target };
  if (f.type === "LOCATION") return { toLoc: f.target };
  if (f.type === "LPN") return { lpn: f.target };
  const [sku, lot] = f.target.split("|");
  return { sku, lot };
}

const lineAllocated = (no, lineNo) => orderAllocs(no).filter((a) => a.lineNo === lineNo).reduce((sum, a) => sum + a.qty, 0);

function refreshOrderStatus(t, no) {
  const o = S.orders.get(no);
  const full = o.lines.every((l) => lineAllocated(no, l.lineNo) >= l.qty);
  const status = full ? "Allocated" : "Draft";
  if (status !== o.status) t.put("orders", { ...o, status });
}

function releaseAlloc(t, a, qty, serials, reason) {
  const s = S.stock.get(a.stockId);
  t.put("stock", { ...s, allocatedQty: s.allocatedQty - qty });
  setSerials(t, a.sku, serials, { allocId: null });
  if (qty === a.qty) t.del("allocs", a.id);
  log(t, "DEALLOCATE", { ...stockFields(a), serials, fromLoc: s.loc, qty, ref: a.orderNo, reason });
}

function applyQtyChange(t, s, type, { newQty, remove = [], add = [], reason }) {
  assertNotFrozen(s, type === "COUNT" ? "count" : "adjust");
  const sku = skuOf(s.sku);
  let target;
  if (sku.serialControlled) {
    const free = new Set(freeSerials(s.id).map((x) => x.serial));
    for (const serial of remove) if (!free.has(serial)) fail(`Serial ${serial} is allocated or not in this record.`);
    target = s.qty - remove.length + add.length;
  } else {
    target = wholeQty(newQty, "New quantity", 0);
  }
  if (target < s.allocatedQty) fail(`Quantity cannot go below the ${s.allocatedQty} allocated.`);
  const delta = target - s.qty;
  if (!delta && !remove.length && !add.length) return false;
  if (target === 0) t.del("stock", s.id);
  else t.put("stock", { ...s, qty: target });
  setSerials(t, s.sku, remove, { status: "REMOVED", stockId: null });
  registerSerials(t, sku, add, s.id);
  log(t, type, {
    ...stockFields(s), serials: [...remove, ...add], toLoc: s.loc, qty: delta, delta, reason,
  });
  return true;
}

const MASTER_TYPE = /^(SKU|LOC)_/;
function skuInUse(code) {
  return stockRows().some((s) => s.sku === code)
    || [...S.asns.values()].some((a) => a.sku === code)
    || [...S.orders.values()].some((o) => o.lines.some((l) => l.sku === code))
    || [...S.history.values()].some((e) => e.sku === code && !MASTER_TYPE.test(e.type));
}
const locationHasStock = (code) => stockRows().some((s) => s.loc === code);
function locationInUse(code) {
  return locationHasStock(code)
    || [...S.history.values()].some((e) => (e.toLoc === code || e.fromLoc === code) && !MASTER_TYPE.test(e.type));
}

// ===== Backup =====
function exportData() {
  const data = Object.fromEntries(Object.keys(STORES).map((k) => [k, [...S[k].values()]]));
  return { app: DB_NAME, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data };
}

function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || obj.app !== DB_NAME) return ["This is not a Warehouse backup file."];
  if (obj.schemaVersion !== SCHEMA_VERSION) return [`Unsupported schema version: ${obj.schemaVersion}.`];
  if (!obj.data || typeof obj.data !== "object") return ["The file has no data section."];
  for (const [name, key] of Object.entries(STORES)) {
    const rows = obj.data[name];
    if (!Array.isArray(rows)) { errors.push(`Missing table: ${name}.`); continue; }
    const seen = new Set();
    for (const r of rows) {
      if (!r || typeof r !== "object" || r[key] === undefined || r[key] === null) { errors.push(`A ${name} record has no ${key}.`); break; }
      if (seen.has(r[key])) { errors.push(`Duplicate ${key} in ${name}: ${r[key]}.`); break; }
      seen.add(r[key]);
    }
  }
  if (errors.length) return errors;
  const skus = new Set(obj.data.skus.map((s) => s.code));
  const locs = new Set(obj.data.locations.map((l) => l.code));
  const stockIds = new Set(obj.data.stock.map((s) => s.id));
  for (const s of obj.data.stock) {
    if (!skus.has(s.sku)) errors.push(`Stock ${s.id} uses unknown SKU ${s.sku}.`);
    if (!locs.has(s.loc)) errors.push(`Stock ${s.id} uses unknown location ${s.loc}.`);
    if (!Number.isInteger(s.qty) || s.qty <= 0 || !Number.isInteger(s.allocatedQty) || s.allocatedQty < 0 || s.allocatedQty > s.qty) {
      errors.push(`Stock ${s.id} has invalid quantities.`);
    }
  }
  for (const s of obj.data.serials) {
    if (s.status === "IN_STOCK" && !stockIds.has(s.stockId)) errors.push(`Serial ${s.serial} points to missing stock.`);
  }
  for (const a of obj.data.allocs) {
    if (!stockIds.has(a.stockId)) errors.push(`Allocation ${a.id} points to missing stock.`);
  }
  return errors.slice(0, 8);
}

function replaceAll(data) {
  return new Promise((resolve, reject) => {
    const names = Object.keys(STORES);
    const tx = idb.transaction(names, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    for (const name of names) {
      const store = tx.objectStore(name);
      store.clear();
      for (const row of data[name] || []) store.put(row);
    }
  }).then(loadAll);
}

async function setMeta(key, value) {
  await act((t) => t.put("meta", { key, value }), { system: true });
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// UTF-8 BOM and CRLF so Excel opens Thai and other text correctly.
function downloadCsv(name, cols, rows) {
  const cell = (v) => {
    let text = String(v ?? "");
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [cols.map((c) => cell(c.t)), ...rows.map((r) => cols.map((c) => cell(c.csv ? c.csv(r) : c.v(r))))];
  downloadFile(name, `﻿${lines.map((l) => l.join(",")).join("\r\n")}\r\n`, "text/csv;charset=utf-8");
}

// ===== Demo data =====
function buildDemo(t) {
  const DAY = 86400000;
  const base = Date.now();
  const at = (daysAgo, hour = 9) => {
    const d = new Date(base - daysAgo * DAY);
    d.setHours(hour, 15, 0, 0);
    return d;
  };
  const addDays = (n) => localDay(new Date(base + n * DAY));
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const people = ["Mali", "Somchai", "Anna"];
  const as = (daysAgo, hour) => { clock = at(daysAgo, hour); t.operator = people[rnd(3)]; };

  as(30);
  for (const [zone, aisle, type] of [["RCV", 1, "Receiving"], ["SHP", 1, "Outbound Staging"]]) {
    for (let bin = 1; bin <= 2; bin += 1) op.addLocation(t, { zone, aisle, rack: 1, bin, type });
  }
  op.bulkLocations(t, { zone: "A", aisleFrom: 1, aisleTo: 2, rackFrom: 1, rackTo: 3, binFrom: 1, binTo: 3, type: "Storage" });
  op.bulkLocations(t, { zone: "B", aisleFrom: 1, aisleTo: 1, rackFrom: 1, rackTo: 4, binFrom: 1, binTo: 2, type: "Storage" });

  const skus = [
    ["BOLT-M8", "Hex bolt M8 x 40", "Hardware", "BOX", "8850001000011", {}],
    ["TAPE-48", "Packing tape 48 mm", "Packaging", "EA", "8850001000028", {}],
    ["GLOVE-L", "Work gloves size L", "Safety", "PAIR", "8850001000035", {}],
    ["MILK-1L", "นมพาสเจอร์ไรส์ 1 ลิตร", "Food", "EA", "8850001000042", { lotControlled: true, expiryControlled: true }],
    ["MED-KIT", "First aid kit", "Safety", "EA", "8850001000059", { lotControlled: true, expiryControlled: true }],
    ["PAINT-5", "Primer paint 5 L", "Chemical", "EA", "8850001000066", { lotControlled: true }],
    ["LAP-14", "Laptop 14 inch", "Electronics", "EA", "8850001000073", { serialControlled: true }],
    ["DRONE-X", "Inspection drone", "Electronics", "EA", "8850001000080", { lotControlled: true, serialControlled: true }],
  ];
  for (const [code, description, category, uom, barcode, flags] of skus) {
    op.saveSku(t, { code, description, category, uom, barcode, ...flags });
  }

  const codes = ["357", "380", "356", "332"];
  const storage = [...S.locations.values()].filter((l) => l.type === "Storage").map((l) => l.code);
  let notice = 1000;
  let serialNo = 1;
  const inbound = (daysAgo, sku, qty, { partial = false, leaveInReceiving = false, lpn = false, expiryDays = 90 } = {}) => {
    const rec = skuOf(sku);
    notice += 1;
    const noticeNo = `N${notice}`;
    as(daysAgo + 1);
    op.createAsn(t, {
      noticeNo, internalOrder: codes[notice % 4], sku, qty, when: at(daysAgo).toISOString(), who: people[rnd(3)],
      scrapReason: SCRAP_REASONS[notice % SCRAP_REASONS.length],
    });
    as(daysAgo, 10);
    const got = partial ? Math.ceil(qty / 2) : qty;
    const stock = op.receive(t, {
      asn: noticeNo, qty: got, loc: "RCV-01-01-01", newLpn: lpn,
      lot: rec.lotControlled ? `L${pad(notice % 100)}` : "",
      expiry: rec.expiryControlled ? addDays(expiryDays - daysAgo) : "",
      serials: rec.serialControlled ? Array.from({ length: got }, () => `${sku}-SN${pad(serialNo++, 4)}`) : [],
    });
    if (leaveInReceiving) return stock;
    as(daysAgo, 13);
    const toLoc = storage[rnd(storage.length)];
    if (stock.lpn) op.moveLpn(t, { lpn: stock.lpn, toLoc, type: "PUTAWAY" });
    else op.move(t, { stockId: stock.id, qty: got, toLoc, type: "PUTAWAY" });
    return stock;
  };

  const plan = [
    ["BOLT-M8", 400], ["MILK-1L", 240], ["LAP-14", 12], ["TAPE-48", 300], ["MED-KIT", 60],
    ["PAINT-5", 80], ["GLOVE-L", 200], ["DRONE-X", 6], ["MILK-1L", 180], ["BOLT-M8", 250],
  ];
  plan.forEach(([sku, qty], i) => inbound(28 - i * 2, sku, qty, { lpn: i % 3 === 0 }));

  let orderIndex = 0;
  const outbound = (daysAgo, sku, qty, stage) => {
    orderIndex += 1;
    as(daysAgo, 8);
    const no = op.createOrder(t, {
      nextProcess: ["Recycle", "Destroy", "Rework"][orderIndex % 3],
      shipDate: localDay(at(daysAgo)), lines: [{ sku, qty }],
    });
    if (stage === "Draft") return no;
    let left = qty;
    const sources = stockRows()
      .filter((s) => s.sku === sku && s.qty > s.allocatedQty && S.locations.get(s.loc).type === "Storage")
      .sort((a, b) => (a.expiry || "z").localeCompare(b.expiry || "z"));
    for (const s of sources) {
      if (!left) break;
      const n = Math.min(left, s.qty - s.allocatedQty);
      op.allocate(t, { no, lineNo: 1, stockId: s.id, qty: n, serials: freeSerials(s.id).slice(0, n).map((x) => x.serial) });
      left -= n;
    }
    if (stage === "Allocated") return no;
    as(daysAgo, 11);
    op.pick(t, { no, picks: [], stagingLoc: "SHP-01-01-01" });
    if (stage === "Picked") return no;
    as(daysAgo, 15);
    op.ship(t, no);
    return no;
  };

  const out = [
    ["BOLT-M8", 60], ["MILK-1L", 48], ["LAP-14", 3], ["TAPE-48", 40], ["GLOVE-L", 30],
    ["MILK-1L", 60], ["MED-KIT", 12], ["BOLT-M8", 90], ["PAINT-5", 15], ["DRONE-X", 2],
  ];
  out.forEach(([sku, qty], i) => outbound(9 - i, sku, qty, "Shipped"));

  as(2, 14);
  for (const sku of ["TAPE-48", "PAINT-5"]) {
    const s = stockRows().find((x) => x.sku === sku && x.qty > x.allocatedQty && S.locations.get(x.loc).type === "Storage");
    op.move(t, { stockId: s.id, qty: Math.min(10, s.qty - s.allocatedQty), toLoc: storage.find((c) => c !== s.loc), toLpn: "" });
  }

  // Open work so every screen has something to show.
  inbound(1, "TAPE-48", 120, { partial: true, leaveInReceiving: true });
  inbound(0, "GLOVE-L", 80, { leaveInReceiving: true, lpn: true });
  inbound(3, "MED-KIT", 20, { expiryDays: -2 }); // arrives already expired
  as(0, 8);
  op.createAsn(t, {
    noticeNo: "N2001", internalOrder: "357", sku: "LAP-14", qty: 5, when: at(-2).toISOString(), who: "Test Line 3", scrapReason: "Failed test",
  });
  op.createAsn(t, {
    noticeNo: "N2002", internalOrder: "332", sku: "BOLT-M8", qty: 100, when: at(-1).toISOString(), who: "Plant 2", scrapReason: "Obsolete",
  });
  outbound(0, "TAPE-48", 25, "Draft");
  outbound(0, "BOLT-M8", 40, "Allocated");
  outbound(0, "GLOVE-L", 20, "Picked");

  as(0, 9);
  op.freeze(t, { type: "LOCATION", target: "B-01-04-02", reason: "Rack damaged, waiting for inspection" });
  const milk = stockRows().find((s) => s.sku === "MILK-1L");
  if (milk) op.freeze(t, { type: "LOT", target: milk.lot, sku: "MILK-1L", reason: "QC hold: temperature check" });
  clock = null;
}

async function loadDemo() {
  await replaceAll({});
  try {
    await act(buildDemo, { system: true });
  } finally {
    clock = null;
  }
}

// ===== UI primitives =====
const view = $("#view");

function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.setAttribute("role", isError ? "alert" : "status");
  el.textContent = msg;
  el.addEventListener("click", () => el.remove());
  $("#toasts").appendChild(el);
  while ($("#toasts").children.length > 3) $("#toasts").firstChild.remove();
  setTimeout(() => el.remove(), isError ? 9000 : 4000);
}

// Runs an action and reports the outcome. Returns the result, or undefined if it failed.
async function run(fn, okMsg) {
  try {
    const result = await act(fn);
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(result) : okMsg);
    return result === undefined ? true : result;
  } catch (e) {
    if (!(e instanceof UserError)) console.error(e);
    toast(e.message, true);
    return undefined;
  }
}

function dialogBox({ title, body = "", ok = "Confirm", danger = false, input = null }) {
  const dlg = $("#dialog");
  dlg.innerHTML = h`
    <form method="dialog">
      <h3>${title}</h3>
      <div class="dlg-body">${body}</div>
      ${input ? h`<label class="field" style="margin-top:12px">${input}<input id="dlg-input" autocomplete="off"></label>` : ""}
      <div class="form-actions">
        <button class="${danger ? "btn-danger" : "btn"}" value="ok">${ok}</button>
        <button class="btn-ghost" value="cancel" formnovalidate>Cancel</button>
      </div>
    </form>`.s;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      const yes = dlg.returnValue === "ok";
      resolve(input ? (yes ? $("#dlg-input", dlg).value : null) : yes);
    }, { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

function table(cols, rows, { empty = "No records.", rowClass, limit = ROW_LIMIT } = {}) {
  if (!rows.length) return h`<p class="empty">${empty}</p>`;
  const shown = rows.slice(0, limit);
  return h`
    <div class="table-wrap"><table>
      <thead><tr>${cols.map((c) => h`<th class="${c.num ? "num" : ""}">${c.t}</th>`)}</tr></thead>
      <tbody>${shown.map((r) => h`<tr class="${rowClass ? rowClass(r) : ""}">${
        cols.map((c) => h`<td class="${c.num ? "num" : ""} ${c.wrap ? "wrap" : ""}">${c.v(r)}</td>`)
      }</tr>`)}</tbody>
    </table></div>
    ${rows.length > limit ? h`<p class="hint" style="margin-top:8px">Showing the first ${fmtNum(limit)} of ${fmtNum(rows.length)}. Narrow the filters to see the rest.</p>` : ""}`;
}

const pageHead = (title, sub = "", actions = "") => h`
  <div class="page-head"><div><h1>${title}</h1>${sub ? h`<p class="sub">${sub}</p>` : ""}</div>
  <div class="actions no-print">${actions}</div></div>`;

const field = (label, control, cls = "") => h`<label class="field ${cls}"><span>${label}</span>${control}</label>`;

const skuOptions = (activeOnly = true) => h`<datalist id="dl-sku">${
  [...S.skus.values()].filter((s) => !activeOnly || s.active).map((s) => h`<option value="${s.code}">${s.description}</option>`)
}</datalist>`;
const locOptions = (id, type) => h`<datalist id="${id}">${
  [...S.locations.values()].filter((l) => l.active && (!type || l.type === type)).map((l) => h`<option value="${l.code}">${l.type}</option>`)
}</datalist>`;

const reasonOptions = () => h`<datalist id="dl-reason">${SCRAP_REASONS.map((r) => h`<option value="${r}"></option>`)}</datalist>`;

const skuLink = (code) => h`<a href="${link("/sku", { code })}">${code}</a>`;
const locLink = (code) => (code ? h`<a href="${link("/location", { code })}">${code}</a>` : "");
const orderLink = (no) => h`<a href="${link("/order", { no })}">${no}</a>`;
const asnStatusBadge = (s) => h`<span class="badge ${s === "Closed" ? "dim" : s === "Open" ? "" : "warn"}">${s}</span>`;
const orderStatusBadge = (s) => h`<span class="badge ${{ Shipped: "good", Cancelled: "dim", Draft: "dim", Picked: "warn" }[s] || ""}">${s}</span>`;

function frozenBadge(freezes) {
  if (!freezes.length) return "";
  return h`<span class="badge frozen" title="${freezes.map((f) => `${freezeLabel(f)}: ${f.reason}`).join("; ")}">❄ Frozen</span>`;
}
const stockBadges = (s) => h`${frozenBadge(freezesOn(s))} ${isExpired(s) ? h`<span class="badge bad">Expired</span>` : ""}`;

const STOCK_COLS = [
  { t: "SKU", v: (s) => skuLink(s.sku), csv: (s) => s.sku },
  { t: "Description", wrap: true, v: (s) => skuOf(s.sku)?.description },
  { t: "Location", v: (s) => locLink(s.loc), csv: (s) => s.loc },
  { t: "LPN", v: (s) => s.lpn },
  { t: "On hand", num: true, v: (s) => s.qty },
  { t: "Allocated", num: true, v: (s) => s.allocatedQty },
  { t: "Available", num: true, v: (s) => availableOf(s) },
  { t: "Status", v: (s) => stockBadges(s), csv: (s) => [isFrozen(s) ? "Frozen" : "", isExpired(s) ? "Expired" : ""].filter(Boolean).join(" ") },
  { t: "Waiting (days)", num: true, v: (s) => waitingDays(s) },
  { t: "Scrap reason", v: (s) => s.scrapReason },
  { t: "Lot", v: (s) => s.lot },
  { t: "Expiry", v: (s) => s.expiry },
  { t: "Notice No.", v: (s) => s.noticeNo },
];

function serialChecks(name, list, { checked = false } = {}) {
  return h`<div class="serial-list">${list.map((x) => h`
    <label class="check small"><input type="checkbox" name="${name}" value="${x}" ${checked ? "checked" : ""}> ${x}</label>`)}</div>`;
}
const checkedValues = (root, name) => $$(`input[name="${name}"]:checked`, root).map((c) => c.value);

function onSubmit(sel, fn, root = view) {
  const form = $(sel, root);
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    fn(Object.fromEntries(new FormData(form)), form);
  });
}
const onClick = (sel, fn, root = view) => $$(sel, root).forEach((el) => el.addEventListener("click", () => fn(el.dataset, el)));

function setView(content) {
  view.innerHTML = content.s;
  const focus = $("[data-focus]", view);
  if (focus) focus.focus();
}

function backupWarning() {
  const hasData = S.skus.size > 0;
  if (!hasData) return "";
  const last = S.meta.get("lastExport")?.value;
  const days = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
  if (days !== null && days < BACKUP_REMINDER_DAYS) return "";
  return h`<div class="notice warn">${last ? `Your last backup was ${days} days ago.` : "You have not made a backup yet."}
    Data lives only in this browser. <a href="${link("/settings")}">Export a backup</a>.</div>`;
}

// ===== Views: Dashboard =====
function viewDashboard() {
  const rows = stockRows();
  const usedLocs = new Set(rows.map((s) => s.loc)).size;
  const openAsns = [...S.asns.values()].filter((a) => a.status !== "Closed").length;
  const openOrders = [...S.orders.values()].filter((o) => !["Shipped", "Cancelled"].includes(o.status)).length;
  const tile = (value, label, href) => h`<a class="tile" href="${href}"><b>${fmtNum(value)}</b><span>${label}</span></a>`;
  const latest = [...S.history.values()].slice(-10).reverse();
  setView(h`
    ${pageHead("Dashboard", "Scrapped units waiting for their next process")}
    ${backupWarning()}
    ${S.skus.size ? "" : h`<div class="notice">The warehouse is empty. <a href="${link("/settings")}">Load demo data</a> or start with <a href="${link("/skus")}">SKUs</a> and <a href="${link("/locations")}">Locations</a>.</div>`}
    <div class="tiles">
      ${tile(S.skus.size, "Total SKUs", link("/skus"))}
      ${tile(usedLocs, "Locations in use", link("/reports", { tab: "utilisation" }))}
      ${tile(rows.reduce((a, s) => a + s.qty, 0), "On-hand units", link("/stock"))}
      ${tile(openAsns, "Open ASNs", link("/asns"))}
      ${tile(openOrders, "Open orders", link("/orders"))}
      ${tile(activeFreezes().length, "Active freezes", link("/freeze"))}
    </div>
    <div class="card"><h3>Latest transactions</h3>${table(HISTORY_COLS.filter((c) => DASHBOARD_HISTORY.includes(c.t)), latest, { empty: "No history yet." })}</div>`);
}

// ===== Views: SKUs =====
function viewSkus() {
  setView(h`
    ${pageHead("SKUs", `${S.skus.size} in the master`, h`<a class="btn" href="${link("/sku", { code: "" })}#new" data-new>New SKU</a>`)}
    <div class="card">
      <input id="filter" placeholder="Filter by code, description, category or barcode" data-focus aria-label="Filter SKUs">
      <div id="results" style="margin-top:12px"></div>
    </div>`);
  const cols = [
    { t: "SKU", v: (s) => skuLink(s.code) },
    { t: "Description", wrap: true, v: (s) => s.description },
    { t: "Category", v: (s) => s.category },
    { t: "UoM", v: (s) => s.uom },
    { t: "Barcode", v: (s) => s.barcode },
    { t: "Tracking", v: (s) => [s.lotControlled && "Lot", s.expiryControlled && "Expiry", s.serialControlled && "Serial"].filter(Boolean).join(", ") },
    { t: "On hand", num: true, v: (s) => stockRows().filter((x) => x.sku === s.code).reduce((a, x) => a + x.qty, 0) },
    { t: "Status", v: (s) => h`<span class="badge ${s.active ? "good" : "dim"}">${s.active ? "Active" : "Inactive"}</span> ${frozenBadge(freezesOn({ sku: s.code }))}` },
  ];
  const draw = () => {
    const q = clean($("#filter").value).toLowerCase();
    const rows = [...S.skus.values()].filter((s) => [s.code, s.description, s.category, s.barcode].join(" ").toLowerCase().includes(q));
    $("#results").innerHTML = table(cols, rows, { empty: "No SKUs yet." }).s;
  };
  $("#filter").addEventListener("input", draw);
  draw();
  $("[data-new]").addEventListener("click", (e) => { e.preventDefault(); nav("/sku", { new: 1 }); });
}

function viewSku({ code, new: isNew }) {
  const sku = code ? skuOf(code) : null;
  if (!isNew && !sku) return viewSkus();
  const used = sku ? skuInUse(sku.code) : false;
  const lock = used ? "disabled" : "";
  const flag = (name, label) => h`<label class="check"><input type="checkbox" name="${name}" ${sku?.[name] ? "checked" : ""} ${lock}> ${label}</label>`;
  const rows = sku ? stockRows().filter((s) => s.sku === sku.code) : [];
  setView(h`
    ${pageHead(sku ? `SKU ${sku.code}` : "New SKU", sku?.description || "", sku ? h`
      <a class="btn-ghost" href="${link("/history", { sku: sku.code })}">History</a>
      <a class="btn-ghost" href="${link("/freeze", { type: "SKU", target: sku.code })}">Freeze</a>
      <button class="btn-ghost" id="toggle">${sku.active ? "Deactivate" : "Activate"}</button>
      ${used ? "" : h`<button class="btn-danger" id="delete">Delete</button>`}` : "")}
    ${sku && freezesOn({ sku: sku.code }).length ? h`<div class="notice frozen">❄ This SKU is frozen: ${freezesOn({ sku: sku.code })[0].reason}</div>` : ""}
    <form class="card" id="sku-form">
      <div class="form-grid">
        ${field("SKU code", h`<input name="code" value="${sku?.code}" required ${used ? "readonly" : ""} data-focus>`)}
        ${field("Description", h`<input name="description" value="${sku?.description}" required>`)}
        ${field("Category", h`<input name="category" value="${sku?.category}">`)}
        ${field("Unit of measure", h`<input name="uom" value="${sku?.uom || "EA"}">`)}
        ${field("Barcode", h`<input name="barcode" value="${sku?.barcode}">`)}
      </div>
      <div class="checks" style="margin-top:14px">
        ${flag("lotControlled", "Lot controlled")}
        ${flag("expiryControlled", "Expiry controlled")}
        ${flag("serialControlled", "Serial controlled")}
      </div>
      ${used ? h`<p class="hint" style="margin-top:8px">The code and tracking settings are locked because this SKU has been used.</p>` : ""}
      <div class="form-actions"><button class="btn">Save</button><a class="btn-ghost" href="${link("/skus")}">Back</a></div>
    </form>
    ${sku ? h`<div class="card"><h3>Current stock</h3>${table(STOCK_COLS, rows, { empty: "No stock." })}</div>` : ""}`);
  onSubmit("#sku-form", async (d, form) => {
    if (used) for (const k of ["lotControlled", "expiryControlled", "serialControlled"]) d[k] = sku[k];
    d.lotControlled = used ? sku.lotControlled : $('[name="lotControlled"]', form).checked;
    d.expiryControlled = used ? sku.expiryControlled : $('[name="expiryControlled"]', form).checked;
    d.serialControlled = used ? sku.serialControlled : $('[name="serialControlled"]', form).checked;
    const rec = await run((t) => op.saveSku(t, d, sku?.code), "SKU saved.");
    if (rec) nav("/sku", { code: rec.code });
  });
  $("#toggle")?.addEventListener("click", async () => {
    if (await run((t) => op.setSkuActive(t, sku.code, !sku.active), "SKU updated.")) render();
  });
  $("#delete")?.addEventListener("click", async () => {
    if (!await dialogBox({ title: `Delete SKU ${sku.code}?`, ok: "Delete", danger: true })) return;
    if (await run((t) => op.deleteSku(t, sku.code), "SKU deleted.")) nav("/skus");
  });
}

// ===== Views: Locations =====
function viewLocations() {
  const typeSelect = h`<select name="type">${LOC_TYPES.map((x) => h`<option ${x === "Storage" ? "selected" : ""}>${x}</option>`)}</select>`;
  setView(h`
    ${pageHead("Locations", `${S.locations.size} locations. Code format: Zone-Aisle-Rack-Bin`)}
    <div class="card">
      <input id="filter" placeholder="Filter by code, zone or type" data-focus aria-label="Filter locations">
      <div id="results" style="margin-top:12px"></div>
    </div>
    <form class="card" id="one-form">
      <h3>Add one location</h3>
      <div class="form-grid">
        ${field("Zone", h`<input name="zone" required>`)}
        ${field("Aisle", h`<input name="aisle" type="number" min="1" value="1" required>`)}
        ${field("Rack", h`<input name="rack" type="number" min="1" value="1" required>`)}
        ${field("Bin", h`<input name="bin" type="number" min="1" value="1" required>`)}
        ${field("Type", typeSelect)}
      </div>
      <div class="form-actions"><button class="btn">Add location</button></div>
    </form>
    <form class="card" id="bulk-form">
      <h3>Bulk generator</h3>
      <div class="form-grid">
        ${field("Zone", h`<input name="zone" required>`)}
        ${field("Aisle from", h`<input name="aisleFrom" type="number" min="1" value="1" required>`)}
        ${field("Aisle to", h`<input name="aisleTo" type="number" min="1" value="3" required>`)}
        ${field("Rack from", h`<input name="rackFrom" type="number" min="1" value="1" required>`)}
        ${field("Rack to", h`<input name="rackTo" type="number" min="1" value="5" required>`)}
        ${field("Bin from", h`<input name="binFrom" type="number" min="1" value="1" required>`)}
        ${field("Bin to", h`<input name="binTo" type="number" min="1" value="4" required>`)}
        ${field("Type", typeSelect)}
      </div>
      <div class="form-actions"><button class="btn">Generate</button></div>
    </form>`);
  const cols = [
    { t: "Code", v: (l) => locLink(l.code) },
    { t: "Zone", v: (l) => l.zone },
    { t: "Type", v: (l) => l.type },
    { t: "Units", num: true, v: (l) => stockRows().filter((s) => s.loc === l.code).reduce((a, s) => a + s.qty, 0) },
    { t: "Status", v: (l) => h`<span class="badge ${l.active ? "good" : "dim"}">${l.active ? "Active" : "Inactive"}</span> ${frozenBadge(freezesOn({ loc: l.code }))}` },
  ];
  const draw = () => {
    const q = clean($("#filter").value).toLowerCase();
    const rows = [...S.locations.values()].filter((l) => [l.code, l.zone, l.type].join(" ").toLowerCase().includes(q))
      .sort((a, b) => a.code.localeCompare(b.code));
    $("#results").innerHTML = table(cols, rows, { empty: "No locations yet.", limit: 100 }).s;
  };
  $("#filter").addEventListener("input", draw);
  draw();
  onSubmit("#one-form", async (d) => {
    if (await run((t) => op.addLocation(t, d), (code) => `Location ${code} added.`)) render();
  });
  onSubmit("#bulk-form", async (d) => {
    if (!clean(d.zone)) return toast("Zone is required.", true);
    const ok = await run((t) => op.bulkLocations(t, d), (r) => `${r.added} locations added, ${r.skipped} already existed.`);
    if (ok) render();
  });
}

// ===== Views: ASNs =====
function viewAsns({ new: isNew }) {
  if (isNew) return viewAsnForm();
  setView(h`
    ${pageHead("ASNs", "Receive orders. One Notice No. covers one SKU", h`<a class="btn" href="${link("/asns", { new: 1 })}">New ASN</a>`)}
    <div class="card">
      <div class="form-grid">
        ${field("Notice No., Internal Order, SKU or reason", h`<input id="f-text" data-focus>`)}
        ${field("Order type", h`<select id="f-type"><option value="">All</option><option>External</option><option>Internal</option></select>`)}
        ${field("Who", h`<input id="f-who">`)}
        ${field("When (date)", h`<input id="f-when" type="date">`)}
        ${field("Status", h`<select id="f-status"><option value="">All</option><option>Open</option><option>Partially Received</option><option>Closed</option></select>`)}
      </div>
      <div id="results" style="margin-top:12px"></div>
    </div>`);
  const cols = [
    { t: "Notice No.", v: (a) => a.noticeNo },
    { t: "Internal Order", v: (a) => a.internalOrder },
    { t: "Type", v: (a) => h`<span class="badge ${a.orderType === "External" ? "" : "dim"}">${a.orderType}</span>` },
    { t: "SKU", v: (a) => skuLink(a.sku) },
    { t: "Expected", num: true, v: (a) => a.qty },
    { t: "Received", num: true, v: (a) => a.receivedQty },
    { t: "Short", num: true, v: (a) => a.shortQty || "" },
    { t: "When", v: (a) => fmt(a.when) },
    { t: "Who", v: (a) => a.who },
    { t: "Scrap reason", v: (a) => a.scrapReason },
    { t: "Status", v: (a) => asnStatusBadge(a.status) },
    { t: "", v: (a) => (a.status === "Closed" ? "" : h`
      <a class="btn-ghost btn-sm" href="${link("/receive", { notice: a.noticeNo })}">Receive</a>
      <button class="btn-ghost btn-sm" data-close="${a.noticeNo}">Close short</button>`) },
  ];
  const draw = () => {
    const text = clean($("#f-text").value).toLowerCase();
    const who = clean($("#f-who").value).toLowerCase();
    const rows = [...S.asns.values()].filter((a) => (
      [a.noticeNo, a.internalOrder, a.sku, a.scrapReason].join(" ").toLowerCase().includes(text)
      && (!$("#f-type").value || a.orderType === $("#f-type").value)
      && a.who.toLowerCase().includes(who)
      && (!$("#f-when").value || dayOf(a.when) === $("#f-when").value)
      && (!$("#f-status").value || a.status === $("#f-status").value)
    )).reverse();
    $("#results").innerHTML = table(cols, rows, { empty: "No ASNs found." }).s;
    onClick("[data-close]", async ({ close }) => {
      const asn = S.asns.get(close);
      const yes = await dialogBox({
        title: `Close ASN ${close}?`,
        body: `${asn.receivedQty} of ${asn.qty} received. The shortage of ${Math.max(asn.qty - asn.receivedQty, 0)} will be recorded.`,
      });
      if (yes && await run((t) => op.closeAsn(t, close), "ASN closed.")) draw();
    });
  };
  $$("#f-text, #f-type, #f-who, #f-when, #f-status").forEach((el) => el.addEventListener("input", draw));
  draw();
}

function viewAsnForm() {
  setView(h`
    ${pageHead("New ASN", "A receive order for one SKU")}
    ${skuOptions()} ${reasonOptions()}
    <form class="card" id="asn-form">
      <div class="form-grid">
        ${field("Notice No.", h`<input name="noticeNo" required data-focus>`)}
        ${field("Internal Order", h`<input name="internalOrder" id="io" required>`)}
        ${field("Order type", h`<input id="io-type" readonly tabindex="-1" placeholder="Set from Internal Order">`)}
        ${field("SKU", h`<input name="sku" list="dl-sku" required>`)}
        ${field("Qty", h`<input name="qty" type="number" min="1" required>`)}
        ${field("When", h`<input name="when" type="datetime-local" required>`)}
        ${field("Who", h`<input name="who" required>`)}
        ${field("Scrap reason", h`<input name="scrapReason" list="dl-reason" required>`)}
        ${field("Lot (optional)", h`<input name="lot">`)}
        ${field("Expiry (optional)", h`<input name="expiry" type="date">`)}
      </div>
      <div class="form-actions"><button class="btn">Create ASN</button><a class="btn-ghost" href="${link("/asns")}">Back</a></div>
    </form>`);
  $("#io").addEventListener("input", (e) => { $("#io-type").value = clean(e.target.value) ? orderTypeOf(e.target.value) : ""; });
  onSubmit("#asn-form", async (d) => {
    if (await run((t) => op.createAsn(t, d), (r) => `ASN ${r.noticeNo} created (${r.orderType}).`)) nav("/asns");
  });
}

// ===== Views: Receive =====
function trackingFields(sku, { lot = "", expiry = "" } = {}) {
  if (!sku) return "";
  return h`
    ${sku.lotControlled ? field("Lot", h`<input name="lot" value="${lot}" required>`) : ""}
    ${sku.expiryControlled ? field("Expiry", h`<input name="expiry" type="date" value="${expiry}" required>`) : ""}
    ${sku.serialControlled ? field("Serials (one per line, count must equal Qty)", h`<textarea name="serials" required></textarea>`, "wide") : ""}`;
}

function viewReceive({ notice, mode }) {
  const asn = notice ? S.asns.get(notice) : null;
  if (!asn && mode !== "blind") {
    const open = [...S.asns.values()].filter((a) => a.status !== "Closed");
    setView(h`
      ${pageHead("Receive", "Scan a Notice No. or choose an open ASN", h`<a class="btn-ghost" href="${link("/receive", { mode: "blind" })}">Blind receipt</a>`)}
      <form class="card" id="scan-form">
        ${field("Notice No.", h`<input name="notice" data-focus autocomplete="off">`)}
      </form>
      <div class="card"><h3>Open ASNs</h3>${table([
        { t: "Notice No.", v: (a) => h`<a href="${link("/receive", { notice: a.noticeNo })}">${a.noticeNo}</a>` },
        { t: "Internal Order", v: (a) => a.internalOrder },
        { t: "Type", v: (a) => a.orderType },
        { t: "SKU", v: (a) => a.sku },
        { t: "Expected", num: true, v: (a) => a.qty },
        { t: "Received", num: true, v: (a) => a.receivedQty },
        { t: "When", v: (a) => fmt(a.when) },
        { t: "Who", v: (a) => a.who },
        { t: "Status", v: (a) => asnStatusBadge(a.status) },
      ], open, { empty: "No open ASNs." })}</div>`);
    onSubmit("#scan-form", (d) => {
      const code = clean(d.notice);
      if (!S.asns.has(code)) return toast(`No ASN with Notice No. ${code}.`, true);
      if (S.asns.get(code).status === "Closed") return toast(`ASN ${code} is closed.`, true);
      nav("/receive", { notice: code });
    });
    return;
  }

  const sku = asn ? skuOf(asn.sku) : null;
  const left = asn ? Math.max(asn.qty - asn.receivedQty, 0) : "";
  setView(h`
    ${pageHead(asn ? `Receive ${asn.noticeNo}` : "Blind receipt", asn
      ? `${asn.orderType} order ${asn.internalOrder}, ${asn.sku} (${sku?.description}), ${asn.scrapReason}, ${asn.receivedQty} of ${asn.qty} received`
      : "Receive without an ASN")}
    ${skuOptions()} ${locOptions("dl-rcv", "Receiving")} ${reasonOptions()}
    <form class="card" id="rcv-form">
      <div class="form-grid">
        ${asn ? "" : field("Notice No. (optional)", h`<input name="blindNotice">`)}
        ${asn ? "" : field("Scrap reason (optional)", h`<input name="scrapReason" list="dl-reason">`)}
        ${asn ? "" : field("SKU", h`<input name="sku" id="rcv-sku" list="dl-sku" required data-focus>`)}
        ${field("Qty", h`<input name="qty" type="number" min="1" value="${left}" required ${asn ? "data-focus" : ""}>`)}
        ${field("Receiving location", h`<input name="loc" list="dl-rcv" required>`)}
        ${field("LPN (optional)", h`<input name="lpn" id="rcv-lpn">`)}
        <label class="check"><input type="checkbox" name="newLpn" id="rcv-new"> New LPN (auto number)</label>
      </div>
      <div class="form-grid" id="track" style="margin-top:12px">${trackingFields(sku, asn || {})}</div>
      <div class="form-actions"><button class="btn">Receive</button><a class="btn-ghost" href="${link("/receive")}">Back</a></div>
    </form>`);
  $("#rcv-sku")?.addEventListener("input", (e) => { $("#track").innerHTML = (trackingFields(resolveSku(e.target.value)) || h``).s; });
  $("#rcv-new").addEventListener("change", (e) => {
    $("#rcv-lpn").disabled = e.target.checked;
    if (e.target.checked) $("#rcv-lpn").value = "";
  });
  onSubmit("#rcv-form", async (d, form) => {
    const payload = { ...d, asn: asn?.noticeNo, newLpn: $("#rcv-new", form).checked, serials: splitList(d.serials) };
    const qty = Number(d.qty);
    if (asn && asn.receivedQty + qty > asn.qty) {
      const over = asn.receivedQty + qty - asn.qty;
      const yes = await dialogBox({ title: "Over-receipt", body: `This is ${over} more than expected on ASN ${asn.noticeNo}. It will be logged. Continue?` });
      if (!yes) return;
      payload.confirmOver = true;
    }
    const rec = await run((t) => op.receive(t, payload), (r) => `Received ${qty} into ${r.loc}${r.lpn ? ` on ${r.lpn}` : ""}.`);
    if (!rec) return;
    if (asn) nav("/receive");
    else render();
  });
}

// ===== Views: Putaway, Move =====
const lpnGroups = (rows) => [...new Set(rows.map((s) => s.lpn).filter(Boolean))];

function viewPutaway({ stock, lpn }) {
  if (stock || lpn) return viewMoveForm({ stock, lpn, type: "PUTAWAY" });
  const rows = stockRows().filter((s) => S.locations.get(s.loc)?.type === "Receiving" && s.qty > s.allocatedQty);
  const cols = [...STOCK_COLS.filter((c) => !["Allocated", "Available"].includes(c.t)), {
    t: "", v: (s) => h`
      <a class="btn-ghost btn-sm" href="${link("/putaway", { stock: s.id })}">Put away</a>
      ${s.lpn ? h`<a class="btn-ghost btn-sm" href="${link("/putaway", { lpn: s.lpn })}">Whole LPN</a>` : ""}`,
  }];
  setView(h`
    ${pageHead("Putaway", "Stock waiting in Receiving locations")}
    <div class="card">${table(cols, rows, { empty: "Nothing is waiting for putaway." })}</div>`);
}

function viewMove({ stock, lpn, q = "" }) {
  if (stock || lpn) return viewMoveForm({ stock, lpn, type: "MOVE" });
  setView(h`
    ${pageHead("Move", "Move stock, pack it into an LPN, or move a whole LPN")}
    <form class="card" id="lpn-form">
      <h3>Move a whole LPN</h3>
      ${field("LPN", h`<input name="lpn" autocomplete="off">`)}
    </form>
    <div class="card">
      <h3>Find stock to move</h3>
      <input id="filter" value="${q}" placeholder="SKU, location, lot, LPN, serial..." data-focus aria-label="Find stock">
      <div id="results" style="margin-top:12px"></div>
    </div>`);
  onSubmit("#lpn-form", (d) => {
    if (!stockRows().some((s) => s.lpn === clean(d.lpn))) return toast(`LPN ${clean(d.lpn)} has no stock.`, true);
    nav("/move", { lpn: clean(d.lpn) });
  });
  const cols = [...STOCK_COLS, { t: "", v: (s) => h`<a class="btn-ghost btn-sm" href="${link("/move", { stock: s.id })}">Move</a>` }];
  bindStockSearch(cols);
}

function bindStockSearch(cols) {
  const draw = () => {
    const rows = searchStock($("#filter").value);
    $("#results").innerHTML = table(cols, rows, { empty: "No stock found.", limit: 100 }).s;
  };
  $("#filter").addEventListener("input", draw);
  draw();
}

function viewMoveForm({ stock, lpn, type }) {
  const putaway = type === "PUTAWAY";
  const back = link(putaway ? "/putaway" : "/move");
  const locList = locOptions("dl-loc", putaway ? "Storage" : undefined);
  const title = putaway ? "Put away" : "Move";

  if (lpn) {
    const rows = stockRows().filter((s) => s.lpn === lpn);
    if (!rows.length) return nav(putaway ? "/putaway" : "/move");
    setView(h`
      ${pageHead(`${title} LPN ${lpn}`, `Now in ${rows[0].loc}`)}
      ${locList}
      <div class="card">${table(STOCK_COLS, rows)}</div>
      <form class="card" id="move-form">
        ${field("To location", h`<input name="toLoc" list="dl-loc" required data-focus>`)}
        <div class="form-actions"><button class="btn">${title} whole LPN</button><a class="btn-ghost" href="${back}">Back</a></div>
      </form>`);
    onSubmit("#move-form", async (d) => {
      if (await run((t) => op.moveLpn(t, { lpn, toLoc: d.toLoc, type }), `LPN ${lpn} moved to ${clean(d.toLoc)}.`)) nav(putaway ? "/putaway" : "/move");
    });
    return;
  }

  const s = S.stock.get(Number(stock));
  if (!s) return nav(putaway ? "/putaway" : "/move");
  const serial = skuOf(s.sku).serialControlled;
  const free = s.qty - s.allocatedQty;
  setView(h`
    ${pageHead(`${title} ${s.sku}`, `From ${s.loc}${s.lpn ? ` on LPN ${s.lpn}` : ""}. ${free} can move`)}
    ${locList}
    <div class="card">${table(STOCK_COLS, [s])}</div>
    <form class="card" id="move-form">
      <div class="form-grid">
        ${serial ? "" : field("Qty", h`<input name="qty" type="number" min="1" max="${free}" value="${free}" required data-focus>`)}
        ${field("To location", h`<input name="toLoc" list="dl-loc" value="${putaway ? "" : s.loc}" required ${serial ? "data-focus" : ""}>`)}
        ${field("To LPN (blank = loose)", h`<input name="toLpn" value="${putaway ? s.lpn : ""}">`)}
      </div>
      ${serial ? h`<h3 style="margin-top:14px">Serials to move</h3>${serialChecks("sn", freeSerials(s.id).map((x) => x.serial), { checked: true })}` : ""}
      <div class="form-actions"><button class="btn">${title}</button><a class="btn-ghost" href="${back}">Back</a></div>
    </form>`);
  onSubmit("#move-form", async (d, form) => {
    const serials = serial ? checkedValues(form, "sn") : undefined;
    const qty = serial ? serials.length : d.qty;
    const ok = await run((t) => op.move(t, { stockId: s.id, qty, toLoc: d.toLoc, toLpn: d.toLpn, serials, type }), `Moved to ${clean(d.toLoc)}.`);
    if (ok) nav(putaway ? "/putaway" : "/move");
  });
}

// ===== Views: Stock search =====
function searchStock(query) {
  const q = clean(query).toLowerCase();
  const rows = stockRows();
  if (!q) return rows;
  const serials = serialIndex();
  return rows.filter((s) => {
    const sku = skuOf(s.sku);
    const asn = S.asns.get(s.noticeNo);
    return [s.sku, sku?.description, sku?.barcode, s.loc, s.lot, s.lpn, s.noticeNo, s.scrapReason, asn?.internalOrder,
      ...(serials.get(s.id) || []).map((x) => x.serial)].join("\n").toLowerCase().includes(q);
  });
}

function viewStock({ q = "" }) {
  const query = clean(q);
  const rows = searchStock(query).sort((a, b) => a.sku.localeCompare(b.sku) || a.loc.localeCompare(b.loc));
  const low = query.toLowerCase();
  const gone = query ? [...S.serials.values()].filter((s) => s.status !== "IN_STOCK" && s.serial.toLowerCase().includes(low)) : [];
  const places = query ? [...S.locations.values()].filter((l) => l.code.toLowerCase().includes(low)).slice(0, 12) : [];
  const stockSerials = serialIndex();
  const matchedSerials = query ? rows.flatMap((s) => (stockSerials.get(s.id) || []).filter((x) => x.serial.toLowerCase().includes(low)).map((x) => ({ ...x, loc: s.loc }))) : [];
  setView(h`
    ${pageHead("Stock Search", "Where is it? Search by SKU, description, barcode, lot, serial, LPN, Notice No., Internal Order, scrap reason or location", h`<button class="btn-ghost" id="csv">Export CSV</button>`)}
    <form class="card" id="search-form">
      <input name="q" value="${query}" placeholder="Scan or type, then press Enter" data-focus autocomplete="off" aria-label="Search stock">
      ${places.length ? h`<div class="chips"><span class="hint">Locations:</span>${places.map((l) => h`<a class="badge" href="${link("/location", { code: l.code })}">${l.code}</a>`)}</div>` : ""}
    </form>
    ${matchedSerials.map((x) => h`<div class="notice">Serial <b>${x.serial}</b> is in location ${locLink(x.loc)}.</div>`).slice(0, 10)}
    ${gone.map((x) => h`<div class="notice">Serial <b>${x.serial}</b> ${x.status === "SHIPPED" ? h`shipped on order ${orderLink(x.orderNo)} at ${fmt(x.shippedAt)}` : "was removed from stock by adjustment"}.</div>`).slice(0, 10)}
    <div class="card">${table(STOCK_COLS, rows, { empty: query ? "No stock matches that search." : "There is no stock yet." })}</div>`);
  onSubmit("#search-form", (d) => nav("/stock", { q: clean(d.q) }));
  $("#csv").addEventListener("click", () => downloadCsv("stock-search.csv", STOCK_COLS, rows));
}

// ===== Views: Location view =====
function viewLocation({ code, q = "" }) {
  if (!code) {
    setView(h`
      ${pageHead("Location View", "What is in this location?")}
      ${locOptions("dl-loc")}
      <form class="card" id="loc-form">${field("Location", h`<input name="code" list="dl-loc" data-focus autocomplete="off">`)}</form>`);
    onSubmit("#loc-form", (d) => {
      if (!S.locations.has(clean(d.code))) return toast(`Location ${clean(d.code)} does not exist.`, true);
      nav("/location", { code: clean(d.code) });
    });
    return;
  }
  const loc = S.locations.get(code);
  if (!loc) { toast(`Location ${code} does not exist.`, true); return nav("/location"); }
  const used = locationInUse(code);
  const hasStock = locationHasStock(code);
  const freezes = freezesOn({ loc: code });
  setView(h`
    ${pageHead(`Location ${code}`, `${loc.type}, zone ${loc.zone}${loc.active ? "" : ", inactive"}`, h`
      <a class="btn-ghost" href="${link("/history", { location: code })}">History</a>
      <a class="btn-ghost" href="${link("/freeze", { type: "LOCATION", target: code })}">Freeze</a>
      ${hasStock ? "" : h`<button class="btn-ghost" id="toggle">${loc.active ? "Deactivate" : "Activate"}</button>`}
      ${used ? "" : h`<button class="btn-danger" id="delete">Delete</button>`}`)}
    ${freezes.length ? h`<div class="notice frozen">❄ This location is frozen: ${freezes[0].reason} (by ${freezes[0].by}, ${fmt(freezes[0].at)})</div>` : ""}
    <div class="card">
      <input id="filter" value="${q}" placeholder="Filter contents by SKU, lot, LPN or serial" data-focus aria-label="Filter contents">
      <div id="results" style="margin-top:12px"></div>
    </div>
    ${hasStock ? "" : h`<form class="card" id="type-form">
      <h3>Location type</h3>
      <div class="form-grid">${field("Type", h`<select name="type">${LOC_TYPES.map((x) => h`<option ${x === loc.type ? "selected" : ""}>${x}</option>`)}</select>`)}</div>
      <div class="form-actions"><button class="btn-ghost">Save type</button></div>
    </form>`}`);
  const cols = STOCK_COLS.filter((c) => c.t !== "Location");
  const draw = () => {
    const rows = searchStock($("#filter").value).filter((s) => s.loc === code)
      .sort((a, b) => a.lpn.localeCompare(b.lpn) || a.sku.localeCompare(b.sku));
    const groups = [...lpnGroups(rows), ""];
    const body = groups.flatMap((g) => {
      const items = rows.filter((s) => s.lpn === g);
      if (!items.length || (!g && !lpnGroups(rows).length)) return items;
      return [{ group: g ? `LPN ${g}` : "Loose stock", frozen: g ? freezesOn({ lpn: g }) : [] }, ...items];
    });
    const wrapped = cols.map((c, i) => ({ ...c, v: (r) => (r.group ? (i === 0 ? h`${r.group} ${frozenBadge(r.frozen)}` : "") : c.v(r)) }));
    $("#results").innerHTML = table(wrapped, body, { empty: "This location is empty.", rowClass: (r) => (r.group ? "group-row" : "") }).s;
  };
  $("#filter").addEventListener("input", draw);
  draw();
  $("#toggle")?.addEventListener("click", async () => {
    if (await run((t) => op.setLocationActive(t, code, !loc.active), "Location updated.")) render();
  });
  $("#delete")?.addEventListener("click", async () => {
    if (!await dialogBox({ title: `Delete location ${code}?`, ok: "Delete", danger: true })) return;
    if (await run((t) => op.deleteLocation(t, code), "Location deleted.")) nav("/locations");
  });
  onSubmit("#type-form", async (d) => {
    if (await run((t) => op.setLocationType(t, code, d.type), "Type saved.")) render();
  });
}

// ===== Views: Adjust =====
function viewAdjust({ stock }) {
  if (!stock) {
    setView(h`
      ${pageHead("Adjust", "Correct a stock record with a reason code")}
      <div class="card">
        <input id="filter" placeholder="SKU, location, lot, LPN, serial..." data-focus aria-label="Find stock">
        <div id="results" style="margin-top:12px"></div>
      </div>`);
    bindStockSearch([...STOCK_COLS, { t: "", v: (s) => h`<a class="btn-ghost btn-sm" href="${link("/adjust", { stock: s.id })}">Adjust</a>` }]);
    return;
  }
  const s = S.stock.get(Number(stock));
  if (!s) return nav("/adjust");
  const serial = skuOf(s.sku).serialControlled;
  setView(h`
    ${pageHead(`Adjust ${s.sku}`, `In ${s.loc}. It cannot go below the ${s.allocatedQty} allocated`)}
    <div class="card">${table(STOCK_COLS, [s])}</div>
    <form class="card" id="adj-form">
      <div class="form-grid">
        ${serial ? "" : field("New quantity", h`<input name="newQty" type="number" min="0" value="${s.qty}" required data-focus>`)}
        ${field("Reason code", h`<select name="reasonCode" required><option value="">Choose...</option>${ADJUST_REASONS.map((r) => h`<option>${r}</option>`)}</select>`)}
        ${field("Note (optional)", h`<input name="note">`)}
      </div>
      ${serial ? h`
        <h3 style="margin-top:14px">Serials to remove</h3>
        ${serialChecks("rm", freeSerials(s.id).map((x) => x.serial))}
        ${field("Serials to add (one per line)", h`<textarea name="add"></textarea>`)}` : ""}
      <div class="form-actions"><button class="btn">Post adjustment</button><a class="btn-ghost" href="${link("/adjust")}">Back</a></div>
    </form>`);
  onSubmit("#adj-form", async (d, form) => {
    const ok = await run((t) => op.adjust(t, {
      stockId: s.id, newQty: d.newQty, reasonCode: d.reasonCode, note: d.note,
      remove: serial ? checkedValues(form, "rm") : [], add: serial ? splitList(d.add) : [],
    }), "Adjustment posted.");
    if (ok) nav("/adjust");
  });
}

// ===== Views: Cycle count =====
let countFound = [];

function viewCount({ locs = "" }) {
  const codes = splitList(locs).filter((c) => S.locations.has(c));
  const rows = stockRows().filter((s) => codes.includes(s.loc)).sort((a, b) => a.loc.localeCompare(b.loc) || a.sku.localeCompare(b.sku));
  const countCell = (s) => {
    if (isFrozen(s)) return h`<span class="hint">Blocked</span>`;
    if (!skuOf(s.sku).serialControlled) return h`<input type="number" min="0" data-count="${s.id}" aria-label="Counted quantity">`;
    return h`<details><summary>${s.qty} serials</summary>
      ${serialChecks(`present-${s.id}`, serialsOf(s.id).map((x) => x.serial), { checked: true })}
      <textarea data-newser="${s.id}" placeholder="Extra serials found, one per line"></textarea></details>`;
  };
  const cols = [
    { t: "Location", v: (s) => locLink(s.loc) }, { t: "SKU", v: (s) => s.sku }, { t: "LPN", v: (s) => s.lpn },
    { t: "Lot", v: (s) => s.lot }, { t: "Expiry", v: (s) => s.expiry },
    { t: "System qty", num: true, v: (s) => s.qty }, { t: "Status", v: (s) => stockBadges(s) }, { t: "Counted", wrap: true, v: countCell },
  ];
  setView(h`
    ${pageHead("Cycle Count", "Choose locations, count, review variances, then post")}
    ${locOptions("dl-loc")} ${skuOptions(false)}
    <form class="card" id="add-loc">
      <div class="form-grid">${field("Add location", h`<input name="code" list="dl-loc" data-focus autocomplete="off">`)}</div>
      <div class="chips">${codes.map((c) => h`<button type="button" class="badge" data-rm="${c}" style="border:0;cursor:pointer" title="Remove">${c} ✕</button> ${frozenBadge(freezesOn({ loc: c }))}`)}</div>
    </form>
    ${codes.length ? h`
      <div class="card"><p class="hint" style="margin-bottom:8px">Leave Counted blank to skip a row.</p>${table(cols, rows, { empty: "The chosen locations are empty." })}</div>
      <form class="card" id="found-form">
        <h3>Found stock that was not expected</h3>
        <div class="form-grid">
          ${field("Location", h`<select name="loc">${codes.map((c) => h`<option>${c}</option>`)}</select>`)}
          ${field("SKU", h`<input name="sku" list="dl-sku" required>`)}
          ${field("Qty", h`<input name="qty" type="number" min="1" required>`)}
          ${field("Lot", h`<input name="lot">`)}
          ${field("Expiry", h`<input name="expiry" type="date">`)}
          ${field("LPN", h`<input name="lpn">`)}
          ${field("Serials (one per line)", h`<textarea name="serials"></textarea>`, "wide")}
        </div>
        <div class="form-actions"><button class="btn-ghost">Add found stock</button></div>
        <div id="found-list" style="margin-top:10px"></div>
      </form>
      <div class="form-actions"><button class="btn" id="review">Review variances</button></div>` : ""}`);
  const nextLocs = (list) => nav("/count", { locs: list.join(",") });
  onSubmit("#add-loc", (d) => {
    const c = clean(d.code);
    if (!S.locations.has(c)) return toast(`Location ${c} does not exist.`, true);
    if (!codes.includes(c)) nextLocs([...codes, c]);
  });
  onClick("[data-rm]", ({ rm }) => nextLocs(codes.filter((c) => c !== rm)));
  const drawFound = () => {
    const el = $("#found-list");
    if (el) el.innerHTML = table([
      { t: "Location", v: (f) => f.loc }, { t: "SKU", v: (f) => f.sku }, { t: "Qty", num: true, v: (f) => f.qty },
      { t: "Lot", v: (f) => f.lot }, { t: "LPN", v: (f) => f.lpn }, { t: "Serials", v: (f) => f.serials.join(", ") },
    ], countFound, { empty: "None added." }).s;
  };
  drawFound();
  onSubmit("#found-form", (d, form) => {
    const sku = resolveSku(d.sku);
    if (!sku) return toast(`SKU "${clean(d.sku)}" does not exist.`, true);
    countFound.push({ ...d, sku: sku.code, serials: splitList(d.serials) });
    form.reset();
    drawFound();
  });
  $("#review")?.addEventListener("click", async () => {
    const lines = [];
    const variance = [];
    for (const s of rows) {
      if (isFrozen(s)) continue;
      if (skuOf(s.sku).serialControlled) {
        const present = checkedValues(view, `present-${s.id}`);
        const remove = serialsOf(s.id).map((x) => x.serial).filter((x) => !present.includes(x));
        const add = splitList($(`[data-newser="${s.id}"]`).value);
        if (!remove.length && !add.length) continue;
        lines.push({ stockId: s.id, remove, add });
        variance.push({ s, counted: s.qty - remove.length + add.length });
      } else {
        const raw = $(`[data-count="${s.id}"]`).value;
        if (raw === "" || Number(raw) === s.qty) continue;
        lines.push({ stockId: s.id, newQty: raw });
        variance.push({ s, counted: Number(raw) });
      }
    }
    if (!lines.length && !countFound.length) return toast("No variances to post.");
    const body = h`${table([
      { t: "Location", v: (r) => r.s.loc }, { t: "SKU", v: (r) => r.s.sku }, { t: "System", num: true, v: (r) => r.s.qty },
      { t: "Counted", num: true, v: (r) => r.counted }, { t: "Variance", num: true, v: (r) => r.counted - r.s.qty },
    ], variance, { empty: "" })}${countFound.length ? h`<p style="margin-top:8px">Plus ${countFound.length} found record(s).</p>` : ""}`;
    if (!await dialogBox({ title: "Post these variances?", body, ok: "Post" })) return;
    const found = countFound;
    const ok = await run((t) => op.postCount(t, { lines, found }), (n) => `${n} variance(s) posted.`);
    if (ok) { countFound = []; render(); }
  });
}

// ===== Views: Freeze =====
function viewFreeze({ type = "SKU", target = "" }) {
  setView(h`
    ${pageHead("Freeze", "Frozen stock cannot be received, put away, moved, allocated, picked, shipped, adjusted or counted")}
    ${skuOptions(false)} ${locOptions("dl-loc")}
    <form class="card" id="fz-form">
      <div class="form-grid">
        ${field("Freeze a", h`<select name="type" id="fz-type">${Object.entries(FREEZE_TYPES).map(([k, v]) => h`<option value="${k}" ${k === type ? "selected" : ""}>${v}</option>`)}</select>`)}
        <label class="field" id="fz-sku-wrap"><span>SKU of the lot</span><input name="sku" list="dl-sku"></label>
        <label class="field"><span id="fz-label">Target</span><input name="target" id="fz-target" value="${target}" required></label>
        ${field("Reason", h`<input name="reason" required ${target ? "data-focus" : ""}>`)}
      </div>
      <div class="form-actions"><button class="btn">Freeze</button></div>
    </form>
    <div class="card">
      <input id="filter" placeholder="Search freezes by target, reason or operator" aria-label="Search freezes">
      <h3 style="margin-top:14px">Active</h3><div id="active"></div>
      <h3 style="margin-top:14px">Past</h3><div id="past"></div>
    </div>`);
  const syncType = () => {
    const v = $("#fz-type").value;
    $("#fz-sku-wrap").hidden = v !== "LOT";
    $("#fz-label").textContent = FREEZE_TYPES[v];
    const input = $("#fz-target");
    if (v === "SKU") input.setAttribute("list", "dl-sku");
    else if (v === "LOCATION") input.setAttribute("list", "dl-loc");
    else input.removeAttribute("list");
  };
  $("#fz-type").addEventListener("change", syncType);
  syncType();
  const base = [
    { t: "Frozen", v: (f) => freezeLabel(f) },
    { t: "Reason", wrap: true, v: (f) => f.reason },
    { t: "By", v: (f) => f.by },
    { t: "At", v: (f) => fmt(f.at) },
  ];
  const draw = () => {
    const q = clean($("#filter").value).toLowerCase();
    const all = [...S.freezes.values()].reverse().filter((f) => [freezeLabel(f), f.reason, f.by, f.releasedBy].join(" ").toLowerCase().includes(q));
    $("#active").innerHTML = table([...base, { t: "", v: (f) => h`<button class="btn-ghost btn-sm" data-release="${f.id}">Release</button>` }],
      all.filter((f) => !f.releasedAt), { empty: "No active freezes." }).s;
    $("#past").innerHTML = table([...base, { t: "Released by", v: (f) => f.releasedBy }, { t: "Released at", v: (f) => fmt(f.releasedAt) }],
      all.filter((f) => f.releasedAt), { empty: "No past freezes." }).s;
    onClick("[data-release]", async ({ release }) => {
      const f = S.freezes.get(Number(release));
      if (!await dialogBox({ title: `Release ${freezeLabel(f)}?`, body: `Frozen for: ${f.reason}`, ok: "Release" })) return;
      if (await run((t) => op.unfreeze(t, f.id), "Freeze released.")) draw();
    });
  };
  $("#filter").addEventListener("input", draw);
  draw();
  onSubmit("#fz-form", async (d) => {
    if (await run((t) => op.freeze(t, d), "Frozen.")) nav("/freeze");
  });
}

// ===== Views: Orders =====
function viewOrders({ new: isNew }) {
  if (isNew) return viewOrderForm();
  const cols = [
    { t: "Order", v: (o) => orderLink(o.no) }, { t: "Next process", v: (o) => o.nextProcess }, { t: "Ship date", v: (o) => o.shipDate },
    { t: "Lines", num: true, v: (o) => o.lines.length }, { t: "Units", num: true, v: (o) => o.lines.reduce((a, l) => a + l.qty, 0) },
    { t: "Short", num: true, v: (o) => o.lines.reduce((a, l) => a + l.shortQty, 0) || "" },
    { t: "Status", v: (o) => orderStatusBadge(o.status) },
  ];
  setView(h`
    ${pageHead("Orders", "Scrapped units going to their next process", h`<a class="btn" href="${link("/orders", { new: 1 })}">New order</a>`)}
    <div class="card">
      <div class="form-grid">
        ${field("Order or next process", h`<input id="f-text" data-focus>`)}
        ${field("Status", h`<select id="f-status"><option value="">All</option>${["Draft", "Allocated", "Picked", "Shipped", "Cancelled"].map((x) => h`<option>${x}</option>`)}</select>`)}
      </div>
      <div id="results" style="margin-top:12px"></div>
    </div>`);
  const draw = () => {
    const q = clean($("#f-text").value).toLowerCase();
    const rows = [...S.orders.values()].filter((o) => `${o.no} ${o.nextProcess}`.toLowerCase().includes(q)
      && (!$("#f-status").value || o.status === $("#f-status").value)).reverse();
    $("#results").innerHTML = table(cols, rows, { empty: "No orders found." }).s;
  };
  $$("#f-text, #f-status").forEach((el) => el.addEventListener("input", draw));
  draw();
}

function viewOrderForm() {
  const lineRow = () => h`<div class="form-grid order-line" style="margin-top:8px">
    ${field("SKU", h`<input data-l="sku" list="dl-sku">`)}
    ${field("Qty", h`<input data-l="qty" type="number" min="1">`)}
  </div>`;
  setView(h`
    ${pageHead("New order", "Send scrapped units to their next process")}
    ${skuOptions()}
    <datalist id="dl-process">${[...new Set([...S.orders.values()].map((o) => o.nextProcess))].map((p) => h`<option value="${p}"></option>`)}</datalist>
    <form class="card" id="order-form">
      <div class="form-grid">
        ${field("Order no. (blank = automatic)", h`<input name="no" data-focus>`)}
        ${field("Next process", h`<input name="nextProcess" list="dl-process" required>`)}
        ${field("Ship date", h`<input name="shipDate" type="date">`)}
      </div>
      <h3 style="margin-top:16px;margin-bottom:0">Lines</h3>
      <div id="lines">${lineRow()}</div>
      <div class="form-actions">
        <button type="button" class="btn-ghost" id="add-line">Add line</button>
        <button class="btn">Create order</button>
        <a class="btn-ghost" href="${link("/orders")}">Back</a>
      </div>
    </form>`);
  $("#add-line").addEventListener("click", () => $("#lines").insertAdjacentHTML("beforeend", lineRow().s));
  onSubmit("#order-form", async (d) => {
    const lines = $$(".order-line").map((row) => ({ sku: $('[data-l="sku"]', row).value, qty: $('[data-l="qty"]', row).value }))
      .filter((l) => clean(l.sku) || clean(l.qty));
    const no = await run((t) => op.createOrder(t, { ...d, lines }), (n) => `Order ${n} created.`);
    if (no) nav("/order", { no });
  });
}

const allocCols = [
  { t: "Line", v: (a) => a.lineNo }, { t: "SKU", v: (a) => a.sku }, { t: "From", v: (a) => a.fromLoc }, { t: "LPN", v: (a) => a.lpn },
  { t: "Lot", v: (a) => a.lot }, { t: "Expiry", v: (a) => a.expiry }, { t: "Qty", num: true, v: (a) => a.qty },
  { t: "Serials", wrap: true, v: (a) => a.serials.join(", ") },
];

function viewOrder({ no }) {
  const o = S.orders.get(no);
  if (!o) { toast(`Order ${no} does not exist.`, true); return nav("/orders"); }
  const allocs = orderAllocs(no);
  const open = !["Shipped", "Cancelled"].includes(o.status);
  setView(h`
    ${pageHead(`Order ${o.no}`, `To ${o.nextProcess}${o.shipDate ? `, ship ${o.shipDate}` : ""}`, h`
      ${orderStatusBadge(o.status)}
      <a class="btn-ghost" href="${link("/history", { order: o.no })}">History</a>
      ${["Draft", "Allocated"].includes(o.status) ? h`<a class="btn-ghost" href="${link("/allocate", { no })}">Allocate</a>` : ""}
      ${o.status === "Allocated" ? h`<a class="btn" href="${link("/pick", { no })}">Pick</a>` : ""}
      ${o.status === "Picked" ? h`<a class="btn" href="${link("/ship", { no })}">Ship</a>` : ""}
      ${open ? h`<button class="btn-danger" id="cancel">Cancel order</button>` : ""}`)}
    <div class="card"><h3>Lines</h3>${table([
      { t: "Line", v: (l) => l.lineNo }, { t: "SKU", v: (l) => skuLink(l.sku) }, { t: "Description", v: (l) => skuOf(l.sku)?.description },
      { t: "Ordered", num: true, v: (l) => l.qty }, { t: "Allocated", num: true, v: (l) => lineAllocated(no, l.lineNo) },
      { t: "Shipped", num: true, v: (l) => l.shippedQty }, { t: "Short", num: true, v: (l) => l.shortQty || "" },
    ], o.lines)}</div>
    ${allocs.length ? h`<div class="card"><h3>Allocations</h3>${table([...allocCols, { t: "State", v: (a) => a.status }], allocs)}</div>` : ""}
    ${o.shipped.length ? h`<div class="card"><h3>Shipped ${fmt(o.shippedAt)}</h3>${table([
      { t: "SKU", v: (x) => x.sku }, { t: "LPN", v: (x) => x.lpn }, { t: "Lot", v: (x) => x.lot }, { t: "Notice No.", v: (x) => x.noticeNo },
      { t: "Qty", num: true, v: (x) => x.qty }, { t: "Serials", wrap: true, v: (x) => x.serials.join(", ") },
    ], o.shipped)}</div>` : ""}`);
  $("#cancel")?.addEventListener("click", async () => {
    const yes = await dialogBox({
      title: `Cancel order ${no}?`, danger: true, ok: "Cancel order",
      body: "All allocations are released. Picked stock stays in staging as available stock.",
    });
    if (yes && await run((t) => op.cancelOrder(t, no), "Order cancelled.")) render();
  });
}

function orderPicker(title, sub, path, statuses, emptyText) {
  const rows = [...S.orders.values()].filter((o) => statuses.includes(o.status)).reverse();
  setView(h`${pageHead(title, sub)}
    <div class="card">${table([
      { t: "Order", v: (o) => h`<a href="${link(path, { no: o.no })}">${o.no}</a>` },
      { t: "Next process", v: (o) => o.nextProcess }, { t: "Ship date", v: (o) => o.shipDate },
      { t: "Units", num: true, v: (o) => o.lines.reduce((a, l) => a + l.qty, 0) },
      { t: "Status", v: (o) => orderStatusBadge(o.status) },
    ], rows, { empty: emptyText })}</div>`);
}

// ===== Views: Allocate, Pick, Ship =====
function viewAllocate({ no }) {
  if (!no) return orderPicker("Allocate", "Choose an order. Allocation is manual", "/allocate", ["Draft", "Allocated"], "No orders are waiting for allocation.");
  const o = S.orders.get(no);
  if (!o || !["Draft", "Allocated"].includes(o.status)) return nav("/allocate");
  const candidatesFor = (line) => stockRows()
    .filter((s) => s.sku === line.sku && availableOf(s) > 0 && S.locations.get(s.loc).type === "Storage")
    .sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999") || a.loc.localeCompare(b.loc));
  const candCols = (line, open) => [
    { t: "Location", v: (s) => locLink(s.loc) }, { t: "LPN", v: (s) => s.lpn }, { t: "Lot", v: (s) => s.lot },
    { t: "Expiry", v: (s) => h`${s.expiry} ${isExpired(s) ? h`<span class="badge bad">Expired</span>` : ""}` },
    { t: "Notice No.", v: (s) => s.noticeNo }, { t: "Available", num: true, v: (s) => availableOf(s) },
    {
      t: "Allocate", wrap: true, v: (s) => {
        const max = Math.min(open, availableOf(s));
        return h`<form class="alloc-form actions" data-line="${line.lineNo}" data-stock="${s.id}">
          ${skuOf(s.sku).serialControlled
            ? h`<details><summary>Choose serials</summary>${serialChecks("sn", freeSerials(s.id).map((x) => x.serial))}</details>`
            : h`<input type="number" name="qty" min="1" max="${max}" value="${max}" style="width:90px" aria-label="Quantity to allocate">`}
          <button class="btn-ghost btn-sm">Allocate</button></form>`;
      },
    },
  ];
  setView(h`
    ${pageHead(`Allocate ${o.no}`, `To ${o.nextProcess}. Earliest expiry is listed first, as a guide only. Frozen stock is hidden`, h`
      ${orderStatusBadge(o.status)}
      ${o.status === "Allocated" ? h`<a class="btn" href="${link("/pick", { no })}">Go to pick</a>` : ""}
      <a class="btn-ghost" href="${link("/order", { no })}">Order</a>`)}
    ${o.lines.map((line) => {
      const done = lineAllocated(no, line.lineNo);
      const open = line.qty - done;
      const mine = orderAllocs(no).filter((a) => a.lineNo === line.lineNo);
      return h`<div class="card">
        <h3>Line ${line.lineNo}: ${line.sku}, ${skuOf(line.sku)?.description}. ${done} of ${line.qty} allocated</h3>
        ${mine.length ? table([...allocCols.slice(2), { t: "", v: (a) => h`<button class="btn-ghost btn-sm" data-dealloc="${a.id}">Deallocate</button>` }], mine) : ""}
        ${open > 0 ? table(candCols(line, open), candidatesFor(line), { empty: "No available stock in Storage locations." }) : ""}
      </div>`;
    })}`);
  onClick("[data-dealloc]", async ({ dealloc }) => {
    if (await run((t) => op.deallocate(t, Number(dealloc)), "Deallocated.")) render();
  });
  $$(".alloc-form", view).forEach((form) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stockId = Number(form.dataset.stock);
    const s = S.stock.get(stockId);
    const serials = checkedValues(form, "sn");
    const serial = skuOf(s.sku).serialControlled;
    const qty = serial ? serials.length : $('[name="qty"]', form).value;
    let confirmExpired = false;
    if (isExpired(s)) {
      if (!await dialogBox({ title: "Expired stock", body: `Lot ${s.lot || "-"} expired on ${s.expiry}. Allocate it anyway?`, ok: "Allocate" })) return;
      confirmExpired = true;
    }
    const ok = await run((t) => op.allocate(t, { no, lineNo: Number(form.dataset.line), stockId, qty, serials, confirmExpired }), "Allocated.");
    if (ok) render();
  }));
}

function viewPick({ no }) {
  if (!no) return orderPicker("Pick", "Fully allocated orders", "/pick", ["Allocated"], "No orders are ready to pick.");
  const o = S.orders.get(no);
  if (!o || o.status !== "Allocated") return nav("/pick");
  const allocs = orderAllocs(no).sort((a, b) => a.fromLoc.localeCompare(b.fromLoc));
  const cols = [
    { t: "Location", v: (a) => a.fromLoc }, { t: "SKU", v: (a) => a.sku }, { t: "Description", v: (a) => skuOf(a.sku)?.description },
    { t: "Lot", v: (a) => a.lot }, { t: "LPN", v: (a) => a.lpn }, { t: "Qty", num: true, v: (a) => a.qty },
    { t: "Status", v: (a) => frozenBadge(freezesOn(S.stock.get(a.stockId))) },
    {
      t: "Picked", wrap: true, v: (a) => (a.serials.length
        ? serialChecks(`pick-${a.id}`, a.serials, { checked: true })
        : h`<input type="number" min="0" max="${a.qty}" value="${a.qty}" data-pick="${a.id}" aria-label="Picked quantity">`),
    },
  ];
  setView(h`
    ${pageHead(`Pick list ${o.no}`, `To ${o.nextProcess}${o.shipDate ? `, ship ${o.shipDate}` : ""}`, h`<button class="btn-ghost" id="print">Print</button>`)}
    ${locOptions("dl-stg", "Outbound Staging")}
    <form class="card" id="pick-form">
      ${table(cols, allocs)}
      <p class="hint" style="margin-top:10px">Enter less than the allocated quantity for a short pick. The remainder is deallocated and logged.</p>
      <div class="form-grid no-print" style="margin-top:12px">
        ${field("Outbound Staging location", h`<input name="stagingLoc" list="dl-stg" required data-focus>`)}
      </div>
      <div class="form-actions"><button class="btn">Confirm pick</button><a class="btn-ghost" href="${link("/order", { no })}">Back</a></div>
    </form>`);
  $("#print").addEventListener("click", () => window.print());
  onSubmit("#pick-form", async (d, form) => {
    const picks = allocs.map((a) => {
      if (!a.serials.length) return { allocId: a.id, qty: $(`[data-pick="${a.id}"]`, form).value };
      const serials = checkedValues(form, `pick-${a.id}`);
      return { allocId: a.id, qty: serials.length, serials };
    });
    if (await run((t) => op.pick(t, { no, picks, stagingLoc: d.stagingLoc }), `Order ${no} picked.`)) nav("/order", { no });
  });
}

function viewShip({ no }) {
  if (!no) return orderPicker("Ship", "Picked orders waiting for shipment", "/ship", ["Picked"], "No orders are ready to ship.");
  const o = S.orders.get(no);
  if (!o || o.status !== "Picked") return nav("/ship");
  const allocs = orderAllocs(no);
  const lines = o.lines.map((l) => {
    const picked = allocs.filter((a) => a.lineNo === l.lineNo).reduce((sum, a) => sum + a.qty, 0);
    return { ...l, picked, short: l.qty - picked };
  });
  setView(h`
    ${pageHead(`Ship ${o.no}`, `To ${o.nextProcess}`)}
    <div class="card">${table([
      { t: "Line", v: (l) => l.lineNo }, { t: "SKU", v: (l) => l.sku }, { t: "Ordered", num: true, v: (l) => l.qty },
      { t: "Picked", num: true, v: (l) => l.picked },
      { t: "Short", num: true, v: (l) => (l.short ? h`<span class="badge warn">${l.short}</span>` : "") },
    ], lines)}</div>
    <div class="card"><h3>Staged stock</h3>${table([
      ...allocCols.filter((c) => c.t !== "From"),
      { t: "Staged at", v: (a) => S.stock.get(a.stockId)?.loc },
      { t: "Status", v: (a) => frozenBadge(freezesOn(S.stock.get(a.stockId))) },
    ], allocs)}</div>
    <div class="form-actions"><button class="btn" id="ship">Confirm shipment</button><a class="btn-ghost" href="${link("/order", { no })}">Back</a></div>`);
  $("#ship").addEventListener("click", async () => {
    const short = lines.reduce((a, l) => a + l.short, 0);
    const yes = await dialogBox({
      title: `Ship order ${no}?`, ok: "Ship",
      body: `A shipment cannot be reversed.${short ? ` ${short} unit(s) will be recorded as short.` : ""}`,
    });
    if (yes && await run((t) => op.ship(t, no), `Order ${no} shipped.`)) nav("/order", { no });
  });
}

// ===== Views: Reports =====
function viewReports(q) {
  const tab = q.tab || "stock";
  const tabs = [["stock", "Stock on hand"], ["waiting", "Waiting time"], ["activity", "Daily activity"], ["utilisation", "Location utilisation"]];
  setView(h`
    ${pageHead("Reports")}
    <div class="tabs no-print">${tabs.map(([k, label]) => h`<a class="${k === tab ? "active" : ""}" href="${link("/reports", { tab: k })}">${label}</a>`)}</div>
    <div id="report"></div>`);
  ({ stock: reportStock, waiting: reportWaiting, activity: reportActivity, utilisation: reportUtilisation }[tab] || reportStock)(q);
}

function reportStock({ by = "sku", text = "" }) {
  const label = { sku: "SKU", location: "Location", lot: "Lot", lpn: "LPN" };
  const keyOf = { sku: (s) => s.sku, location: (s) => s.loc, lot: (s) => (s.lot ? `${s.sku} / ${s.lot}` : ""), lpn: (s) => s.lpn };
  const groups = new Map();
  for (const s of searchStock(text)) {
    const k = keyOf[by](s) || "(none)";
    const g = groups.get(k) || { key: k, onHand: 0, allocated: 0, frozen: 0, available: 0 };
    const free = s.qty - s.allocatedQty;
    const frozen = isFrozen(s) ? free : 0;
    g.onHand += s.qty;
    g.allocated += s.allocatedQty;
    g.frozen += frozen;
    g.available += free - frozen;
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const cols = [
    { t: label[by], v: (r) => r.key },
    ...(by === "sku" ? [{ t: "Description", v: (r) => skuOf(r.key)?.description }] : []),
    { t: "On hand", num: true, v: (r) => r.onHand }, { t: "Allocated", num: true, v: (r) => r.allocated },
    { t: "Frozen", num: true, v: (r) => r.frozen }, { t: "Available", num: true, v: (r) => r.available },
  ];
  $("#report").innerHTML = h`
    <form class="card no-print" id="filters"><div class="form-grid">
      ${field("Group by", h`<select name="by">${Object.entries(label).map(([k, v]) => h`<option value="${k}" ${k === by ? "selected" : ""}>${v}</option>`)}</select>`)}
      ${field("Filter", h`<input name="text" value="${text}" placeholder="SKU, location, lot...">`)}
    </div><div class="form-actions"><button class="btn">Apply</button><button type="button" class="btn-ghost" id="csv">Export CSV</button></div></form>
    <div class="card"><p class="hint" style="margin-bottom:8px">Frozen is unallocated stock under a freeze. On hand = Allocated + Frozen + Available.</p>${table(cols, rows, { empty: "No stock." })}</div>`.s;
  onSubmit("#filters", (d) => nav("/reports", { tab: "stock", ...d }));
  $("#csv").addEventListener("click", () => downloadCsv("stock-on-hand.csv", cols, rows));
}

function reportWaiting({ text = "" }) {
  const stock = searchStock(text).sort((a, b) => waitingDays(b) - waitingDays(a));
  const buckets = [["0-7 days", 0, 7], ["8-30 days", 8, 30], ["31-60 days", 31, 60], ["61-90 days", 61, 90], ["Over 90 days", 91, Infinity]];
  const rows = buckets.map(([label, min, max]) => {
    const inside = stock.filter((s) => waitingDays(s) >= min && waitingDays(s) <= max);
    return { label, records: inside.length, units: inside.reduce((a, s) => a + s.qty, 0) };
  });
  const cols = [{ t: "Waiting", v: (r) => r.label }, { t: "Stock records", num: true, v: (r) => r.records }, { t: "Units", num: true, v: (r) => r.units }];
  $("#report").innerHTML = h`
    <form class="card no-print" id="filters"><div class="form-grid">
      ${field("Filter", h`<input name="text" value="${text}" placeholder="SKU, location, scrap reason...">`)}
    </div><div class="form-actions"><button class="btn">Apply</button><button type="button" class="btn-ghost" id="csv">Export CSV</button></div></form>
    <div class="card"><p class="hint" style="margin-bottom:8px">Days since each unit was received, up to today.</p>${table(cols, rows)}</div>
    <div class="card"><h3>Longest waiting</h3>${table(STOCK_COLS, stock, { empty: "No stock.", limit: 50 })}</div>`.s;
  onSubmit("#filters", (d) => nav("/reports", { tab: "waiting", ...d }));
  $("#csv").addEventListener("click", () => downloadCsv("waiting-time.csv", STOCK_COLS, stock));
}

function reportActivity({ by = "day", from, to, orderType = "" }) {
  const end = to || today();
  const start = from || localDay(new Date(new Date(`${end}T00:00:00`).getTime() - 29 * 86400000));
  const label = { day: "Day", sku: "SKU", operator: "Operator" };
  const keyOf = { day: (e) => dayOf(e.at), sku: (e) => e.sku, operator: (e) => e.operator };
  const types = new Set(ACTIVITY.map((a) => a.type));
  const groups = new Map();
  for (const e of S.history.values()) {
    if (!types.has(e.type)) continue;
    const day = dayOf(e.at);
    if (day < start || day > end) continue;
    if (e.type === "RECEIVE" && orderType && e.orderType !== orderType) continue;
    const k = keyOf[by](e);
    const g = groups.get(k) || { key: k, RECEIVE: 0, PUTAWAY: 0, MOVE: 0, PICK: 0, SHIP: 0 };
    g[e.type] += e.qty;
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  const cols = [{ t: label[by], v: (r) => r.key }, ...ACTIVITY.map((a) => ({ t: a.label, num: true, v: (r) => r[a.type] }))];
  $("#report").innerHTML = h`
    <form class="card no-print" id="filters"><div class="form-grid">
      ${field("From", h`<input type="date" name="from" value="${start}">`)}
      ${field("To", h`<input type="date" name="to" value="${end}">`)}
      ${field("Group by", h`<select name="by">${Object.entries(label).map(([k, v]) => h`<option value="${k}" ${k === by ? "selected" : ""}>${v}</option>`)}</select>`)}
      ${field("Receipts from", h`<select name="orderType">${[["", "All orders"], ["External", "External only"], ["Internal", "Internal only"]].map(([k, v]) => h`<option value="${k}" ${k === orderType ? "selected" : ""}>${v}</option>`)}</select>`)}
    </div><div class="form-actions"><button class="btn">Apply</button><button type="button" class="btn-ghost" id="csv">Export CSV</button></div></form>
    <div class="card chart" id="chart-card"><h3>Units by activity</h3>
      <div class="legend">${ACTIVITY.map((a) => h`<span><i style="background:${a.color}"></i>${a.label}</span>`)}</div>
      <div id="chart"></div></div>
    <div class="card">${table(cols, rows, { empty: "No activity in this period." })}</div>`.s;
  onSubmit("#filters", (d) => nav("/reports", { tab: "activity", ...d }));
  $("#csv").addEventListener("click", () => downloadCsv("daily-activity.csv", cols, rows));
  drawActivityChart(rows);
}

function niceMax(v) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= v);
}

// Stacked bars on one axis: all five measures are units, so they share a scale.
function drawActivityChart(allRows) {
  const box = $("#chart");
  if (!allRows.length) { box.innerHTML = h`<p class="empty">No activity in this period.</p>`.s; return; }
  const rows = allRows.slice(-45);
  const total = (r) => ACTIVITY.reduce((a, s) => a + r[s.type], 0);
  const W = Math.max(box.clientWidth, 320);
  const H = 260;
  const M = { top: 10, right: 8, bottom: 26, left: 48 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const top = niceMax(Math.max(...rows.map(total)));
  const y = (v) => M.top + plotH - (v / top) * plotH;
  const slot = plotW / rows.length;
  const barW = Math.max(Math.min(slot - 4, 28), 3);
  const labelEvery = Math.ceil(rows.length / Math.floor(plotW / 78));
  const short = (k) => (/^\d{4}-/.test(k) ? k.slice(5) : k.length > 10 ? `${k.slice(0, 9)}…` : k);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const grid = ticks.map((v) => `
    <line x1="${M.left}" x2="${W - M.right}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(140,150,255,.12)"/>
    <text x="${M.left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#9aa0c7">${fmtNum(v)}</text>`).join("");

  const bars = rows.map((r, i) => {
    const x = M.left + i * slot + (slot - barW) / 2;
    let acc = 0;
    const present = ACTIVITY.filter((s) => r[s.type] > 0);
    const segs = present.map((s, j) => {
      const y1 = y(acc + r[s.type]);
      const hgt = Math.max(y(acc) - y1 - (j < present.length - 1 ? 2 : 0), 1);
      acc += r[s.type];
      const rad = j === present.length - 1 ? Math.min(4, barW / 2, hgt) : 0;
      return `<path fill="${s.color}" d="M${x} ${y1 + hgt}V${y1 + rad}Q${x} ${y1} ${x + rad} ${y1}H${x + barW - rad}Q${x + barW} ${y1} ${x + barW} ${y1 + rad}V${y1 + hgt}Z"/>`;
    }).join("");
    const label = i % labelEvery === 0
      ? `<text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#9aa0c7">${esc(short(r.key))}</text>` : "";
    return `${segs}${label}<rect data-i="${i}" x="${M.left + i * slot}" y="${M.top}" width="${slot}" height="${plotH}" fill="transparent"/>`;
  }).join("");

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Stacked bar chart of units by activity. The table below has the same data.">${grid}${bars}</svg>`;

  const tip = $("#chart-tip");
  const svg = $("svg", box);
  svg.addEventListener("pointermove", (e) => {
    const i = e.target.dataset?.i;
    if (i === undefined) { tip.hidden = true; return; }
    const r = rows[i];
    tip.innerHTML = h`<b>${r.key}</b>${ACTIVITY.map((s) => h`<div><span><i style="background:${s.color}"></i>${s.label}</span><span>${fmtNum(r[s.type])}</span></div>`)}`.s;
    tip.hidden = false;
    const left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; });
}

function reportUtilisation() {
  const zones = new Map();
  const used = new Set(stockRows().map((s) => s.loc));
  for (const l of S.locations.values()) {
    if (!l.active) continue;
    const z = zones.get(l.zone) || { zone: l.zone, total: 0, used: 0, empty: 0, frozen: 0 };
    z.total += 1;
    if (used.has(l.code)) z.used += 1; else z.empty += 1;
    if (freezesOn({ loc: l.code }).length) z.frozen += 1;
    zones.set(l.zone, z);
  }
  const rows = [...zones.values()].sort((a, b) => a.zone.localeCompare(b.zone));
  if (rows.length) {
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    rows.push({ zone: "All zones", total: sum("total"), used: sum("used"), empty: sum("empty"), frozen: sum("frozen") });
  }
  const pct = (r, k) => `${r.total ? Math.round((r[k] / r.total) * 100) : 0}%`;
  const cols = [
    { t: "Zone", v: (r) => r.zone }, { t: "Locations", num: true, v: (r) => r.total },
    { t: "Used", num: true, v: (r) => r.used }, { t: "Used %", num: true, v: (r) => pct(r, "used") },
    { t: "Empty", num: true, v: (r) => r.empty }, { t: "Empty %", num: true, v: (r) => pct(r, "empty") },
    { t: "Frozen", num: true, v: (r) => r.frozen }, { t: "Frozen %", num: true, v: (r) => pct(r, "frozen") },
  ];
  $("#report").innerHTML = h`
    <div class="card">
      <div class="form-actions no-print" style="margin:0 0 10px"><button class="btn-ghost" id="csv">Export CSV</button></div>
      <p class="hint" style="margin-bottom:8px">Active locations only. A frozen location also counts as Used or Empty.</p>
      ${table(cols, rows, { empty: "No locations yet.", rowClass: (r) => (r.zone === "All zones" ? "group-row" : "") })}
    </div>`.s;
  $("#csv").addEventListener("click", () => downloadCsv("location-utilisation.csv", cols, rows));
}

// ===== Views: History =====
const HISTORY_COLS = [
  { t: "Time", v: (e) => fmt(e.at) },
  { t: "Type", v: (e) => h`<span class="badge dim">${e.type}</span>`, csv: (e) => e.type },
  { t: "Operator", v: (e) => e.operator },
  { t: "SKU", v: (e) => e.sku },
  { t: "Qty", num: true, v: (e) => e.qty || "" },
  { t: "From", v: (e) => e.fromLoc },
  { t: "To", v: (e) => e.toLoc },
  { t: "Lot", v: (e) => e.lot },
  { t: "Expiry", v: (e) => e.expiry },
  { t: "LPN", v: (e) => e.lpn },
  { t: "Notice No.", v: (e) => e.noticeNo },
  { t: "Scrap reason", v: (e) => e.scrapReason },
  { t: "Serials", wrap: true, v: (e) => e.serials.join(", ") },
  { t: "Ref", v: (e) => e.ref },
  { t: "Reason", wrap: true, v: (e) => e.reason },
];
const DASHBOARD_HISTORY = ["Time", "Type", "Operator", "SKU", "Qty", "From", "To", "Ref", "Reason"];
const historyTable = (rows) => table(HISTORY_COLS, rows, { empty: "No history yet." });

function viewHistory(q) {
  const has = (v, want) => !want || String(v ?? "").toLowerCase().includes(clean(want).toLowerCase());
  const rows = [...S.history.values()].filter((e) => (
    (!q.from || dayOf(e.at) >= q.from) && (!q.to || dayOf(e.at) <= q.to)
    && (!q.type || e.type === q.type) && has(e.operator, q.operator) && has(e.sku, q.sku) && has(e.lot, q.lot)
    && has(e.serials.join(" "), q.serial) && has(e.lpn, q.lpn) && has(e.noticeNo, q.notice) && has(e.scrapReason, q.reason)
    && (!q.location || has(e.fromLoc, q.location) || has(e.toLoc, q.location)) && has(e.ref, q.order)
  )).reverse();
  const input = (name, label, type = "text") => field(label, h`<input name="${name}" type="${type}" value="${q[name]}">`);
  setView(h`
    ${pageHead("History", `${fmtNum(rows.length)} entries. History cannot be edited or deleted`)}
    <form class="card no-print" id="filters">
      <div class="form-grid">
        ${input("from", "From", "date")} ${input("to", "To", "date")}
        ${field("Type", h`<select name="type"><option value="">All</option>${HISTORY_TYPES.map((x) => h`<option ${x === q.type ? "selected" : ""}>${x}</option>`)}</select>`)}
        ${input("operator", "Operator")} ${input("sku", "SKU")} ${input("lot", "Lot")} ${input("serial", "Serial")}
        ${input("lpn", "LPN")} ${input("notice", "Notice No.")} ${input("reason", "Scrap reason")} ${input("location", "Location")} ${input("order", "Order / ref")}
      </div>
      <div class="form-actions">
        <button class="btn">Apply</button>
        <a class="btn-ghost" href="${link("/history")}">Clear</a>
        <button type="button" class="btn-ghost" id="csv">Export CSV</button>
      </div>
    </form>
    <div class="card">${historyTable(rows)}</div>`);
  onSubmit("#filters", (d) => nav("/history", d));
  $("#csv").addEventListener("click", () => downloadCsv("history.csv", HISTORY_COLS, rows));
}

// ===== Views: Settings =====
function viewSettings() {
  const last = S.meta.get("lastExport")?.value;
  const counts = Object.keys(STORES).filter((k) => k !== "meta").map((k) => `${k}: ${S[k].size}`).join(", ");
  setView(h`
    ${pageHead("Settings", "Data lives only in this browser on this device")}
    ${backupWarning()}
    <div class="card">
      <h3>Backup</h3>
      <p class="muted small" style="margin-bottom:10px">Last export: ${last ? fmt(last) : "never"}. Records: ${counts}.</p>
      <div class="actions">
        <button class="btn" id="export">Export JSON</button>
        <label class="btn-ghost">Import JSON<input type="file" id="import" accept=".json,application/json" hidden></label>
      </div>
    </div>
    <div class="card">
      <h3>Demo and reset</h3>
      <p class="muted small" style="margin-bottom:10px">Demo data replaces everything with a sample warehouse and about a month of history.</p>
      <div class="actions">
        <button class="btn-ghost" id="demo">Load demo data</button>
        <button class="btn-danger" id="reset">Reset all data</button>
      </div>
    </div>`);
  $("#export").addEventListener("click", async () => {
    const stamp = localDay(new Date());
    downloadFile(`warehouse-backup-${stamp}.json`, JSON.stringify(exportData(), null, 1), "application/json");
    await setMeta("lastExport", new Date().toISOString());
    toast("Backup exported.");
    render();
  });
  $("#import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let obj;
    try {
      obj = JSON.parse(await file.text());
    } catch {
      return toast("Import failed: the file is not valid JSON. Nothing changed.", true);
    }
    const errors = validateBackup(obj);
    if (errors.length) return toast(`Import failed: ${errors.join(" ")} Nothing changed.`, true);
    const summary = Object.keys(STORES).filter((k) => k !== "meta").map((k) => `${k}: ${obj.data[k].length}`).join(", ");
    const yes = await dialogBox({ title: "Replace all data?", body: `The file holds ${summary}. All current data will be replaced.`, ok: "Replace", danger: true });
    if (!yes) return;
    await replaceAll(obj.data);
    toast("Import finished.");
    render();
  });
  $("#demo").addEventListener("click", async () => {
    if (S.skus.size && !await dialogBox({ title: "Load demo data?", body: "This replaces all current data.", ok: "Load demo", danger: true })) return;
    await loadDemo();
    toast("Demo data loaded.");
    nav("/");
  });
  $("#reset").addEventListener("click", async () => {
    const typed = await dialogBox({ title: "Reset all data?", body: "This deletes everything in this browser. It cannot be undone.", input: "Type RESET to confirm", ok: "Reset", danger: true });
    if (typed === null) return;
    if (typed !== "RESET") return toast("Nothing was reset. You must type RESET.", true);
    await replaceAll({});
    toast("All data deleted.");
    nav("/");
  });
}

// ===== Router =====
const routes = {
  "/": viewDashboard, "/skus": viewSkus, "/sku": viewSku, "/locations": viewLocations, "/asns": viewAsns,
  "/receive": viewReceive, "/putaway": viewPutaway, "/stock": viewStock, "/location": viewLocation, "/move": viewMove,
  "/adjust": viewAdjust, "/count": viewCount, "/freeze": viewFreeze, "/orders": viewOrders, "/order": viewOrder,
  "/allocate": viewAllocate, "/pick": viewPick, "/ship": viewShip, "/reports": viewReports, "/history": viewHistory,
  "/settings": viewSettings,
};
// Detail screens light up their parent menu entry.
const MENU_PARENT = { "/sku": "/skus", "/order": "/orders" };

function parseHash() {
  const [path, qs] = (location.hash.slice(1) || "/").split("?");
  return { path, q: Object.fromEntries(new URLSearchParams(qs || "")) };
}

function nav(path, params = {}) {
  const target = link(path, params);
  if (location.hash === target) render();
  else location.hash = target;
}

function drawMenu(path) {
  const active = MENU_PARENT[path] || path;
  $("#sidebar").innerHTML = h`${MENU.map(([group, items]) => h`
    <h2>${group}</h2>
    ${items.map(([href, label]) => h`<a href="#${href}" class="${href === active ? "active" : ""}" ${href === active ? h`aria-current="page"` : ""}>${label}</a>`)}`)}`.s;
}

function render() {
  const { path, q } = parseHash();
  drawMenu(path);
  $("#sidebar").classList.remove("open");
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  $("#chart-tip").hidden = true;
  (routes[path] || viewDashboard)(q);
  window.scrollTo(0, 0);
}

function initShell() {
  const opInput = $("#operator");
  const syncOperator = () => opInput.classList.toggle("needed", !operator);
  opInput.value = operator;
  syncOperator();
  opInput.addEventListener("input", () => {
    operator = clean(opInput.value);
    try { localStorage.setItem("wh-operator", operator); } catch { /* storage blocked */ }
    syncOperator();
  });
  $("#global-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = clean($("#global-q").value);
    $("#global-q").value = "";
    nav("/stock", { q });
  });
  $("#menu-toggle").addEventListener("click", () => {
    const open = $("#sidebar").classList.toggle("open");
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  });
  window.addEventListener("hashchange", render);
}

(async () => {
  initShell();
  try {
    idb = await openDb();
    await loadAll();
    render();
  } catch (e) {
    console.error(e);
    view.innerHTML = h`<div class="notice warn">This browser could not open its database, so the app cannot run: ${e.message}</div>`.s;
  }
})();
