# Build prompt: Warehouse (WMS) app for SpacePlayground

Build a new app called **Warehouse** in the SpacePlayground repo: a browser-only Warehouse
Management System for learning and demos. It handles **scrapped units waiting for their next
process**: units arrive on a receive order, wait in storage, and go out on an order to a next
process such as Recycle, Destroy or Rework. It covers master data, inbound, inventory, outbound,
reports and history for one warehouse. One person uses it at a time, and it holds a few thousand
records at most.

## 1. Technical constraints

- Put the app in `warehouse/`, as a single-page app in plain HTML, CSS and JavaScript. Use no
  backend, no framework and no build step. Split it into `index.html`, `style.css`, `app.js` and `stars.js`,
  as `run-coach/` does.
- Add a card to the `apps` array in the root `index.html`, replacing the "App Three" placeholder:
  icon 📦, name "Warehouse", url `warehouse/`.
- Reuse the SpacePlayground look: the dark space theme and CSS variables from
  `run-coach/style.css`, with the Orbitron and Inter fonts. Tables and forms come first, so keep
  decoration light and text readable.
- All screen text is in English. Stored data can contain any language, such as Thai.
- Use hash routing (`#/stock`, `#/orders/SO-0001`) so that the back button and refresh work.
- Escape all user-entered and imported text before rendering it.
- Work on desktop first, and stay usable on a phone or tablet.
- A USB barcode scanner acts as a keyboard, so search and scan fields take focus automatically and
  submit on Enter. Camera scanning is out of scope.

## 2. Data storage

- Store all data in IndexedDB, in a database named `spaceplayground-warehouse`, and save
  automatically.
- Each business action (such as one receipt or one move) runs in a single IndexedDB transaction.
  It updates stock and writes history together, or does neither.
- **Export** downloads the whole database as one JSON file that includes a `schemaVersion`.
- **Import** validates the file, shows record counts, and replaces all data only after the user
  confirms.
- Show the date of the last export in Settings, and remind the user to back up after 7 days or more.
- Settings also has **Load demo data** and **Reset all data**. Reset requires typing `RESET`.
- Demo data includes zones, locations, SKUs of each tracking type, External ASNs (`357`, `380`),
  Internal ASNs (`356`, `332`), orders, stock, an active freeze and enough history to fill the reports.

## 3. Operator

There is no login. The operator types a name, which is remembered and shown in the header. Every
transaction records that name. Transactions are blocked until a name is set.

## 4. Master data

### SKU master

| Field | Notes |
|---|---|
| SKU code | Required, unique, cannot change after first use |
| Description | Required |
| Category | Optional |
| Unit of measure | One base unit per SKU, such as EA or BOX |
| Barcode | Optional, unique, searchable |
| Lot controlled | Yes/No |
| Expiry controlled | Yes/No |
| Serial controlled | Yes/No |
| Status | Active or Inactive |

- Tracking flags cannot change once the SKU has stock or history.
- A SKU with history can be deactivated but not deleted.
- Inactive SKUs cannot be used in new ASNs or orders.

### Location master

- Hierarchy: Zone > Aisle > Rack > Bin, with a generated code such as `A-01-02-03`.
- Types: Receiving, Storage, Outbound Staging.
- Include a bulk generator, for example Zone A, aisles 1-3, racks 1-5, bins 1-4.
- A location can hold several SKUs.
- A location with stock or history can be deactivated (only when empty) but not deleted.

## 5. Stock model

A **stock record** is a unique combination of SKU + location + lot + expiry + LPN + Notice No. +
scrap reason. It holds `qty`, `allocatedQty` and `receivedAt`. Stock with a different Notice No. or
scrap reason never merges.

- **Available** = `qty` - `allocatedQty`, or 0 if the record is frozen.
- **Lot / expiry:** required at receipt when the SKU flags require them.
- **Serial:** the user enters one unique serial per unit at receipt. Each serial points to its
  stock record and follows it through every move. Any partial move, allocation or pick of a
  serial-controlled SKU requires choosing the specific serials. A serial cannot be in stock twice.
- **LPN (pallet/carton):** optional. An LPN has an ID (auto-generated or typed), sits in exactly
  one location, and can hold mixed SKUs.
- **Notice No.:** the ASN number. It stays on the stock from receipt through shipment, so any
  stock or shipped unit can be traced back to its ASN.
- **Waiting time:** whole days since `receivedAt`. Moves and picks keep the date, and merged stock
  keeps the oldest date.
- Quantities are whole numbers and can never go negative.

## 6. Transactions

### Receive

- **ASN (receive order):** one Notice No. covers exactly one SKU, so an ASN is a single record
  with no separate lines. Status: Open, Partially Received, Closed.

  | Field | Notes |
  |---|---|
  | Notice No. | Required and unique. A duplicate is rejected |
  | Internal Order | Required code that sets the order type (see below) |
  | Order type | External or Internal, set automatically from Internal Order |
  | SKU | Required, one per Notice No. |
  | Qty | Required expected quantity, above 0 |
  | When | Required date and time of the receive order |
  | Who | Required person or party who raised the receive order |
  | Scrap reason | Required. Suggestions: Damaged, Failed test, Obsolete, Expired, Rework reject. Other text is allowed |
  | Lot, expiry | Optional |

- **Order type:** Internal Order codes `357` and `380` are External. Every other code, such as
  `356` or `332`, is Internal. These two External codes are fixed in the app.
- **When** and **Who** come from the receive order. They are separate from the operator and
  timestamp recorded for each actual receipt.
- Receive against an ASN, with partial receipts allowed. Receiving more than expected shows a
  warning and needs confirmation, and is logged.
- Blind receipt without an ASN is allowed. Notice No. is then optional free text, and has no
  Internal Order or order type. A typed Notice No. that matches an existing ASN is rejected, and
  the user is sent to receive against that ASN.
- Received stock goes into a Receiving-type location, with lot, expiry, serials and LPN captured
  as the SKU requires.
- The user can close an ASN that is short. The shortage is recorded.

### Putaway

- List the stock waiting in Receiving locations.
- Move stock or a whole LPN into a Storage location, in full or in part.

### Move

- Move a quantity of a stock record, or a whole LPN in one action, to another location.
- Moving into or out of an LPN (pack and unpack) is part of Move.
- Only available quantity can move. An LPN holding allocated stock cannot move as a whole.

### Outbound order

- Header (order no., next process, ship date) and lines (SKU, qty). Next process is required text,
  and past values are offered as suggestions.
- Status: Draft, Allocated, Picked, Shipped, Cancelled.

### Allocate (manual only)

- There is no auto-allocation. For each order line, the user chooses the exact stock records
  (location, lot, LPN, serials) and quantities.
- A line can be split across several stock records.
- List candidates by earliest expiry first as a guide only, and hide frozen stock. Only stock in
  Storage locations can be allocated.
- Allocating expired stock shows a warning and needs confirmation.
- Allocation increases `allocatedQty`. Deallocation releases it, and is allowed at any time before
  pick.
- The order becomes Allocated when every line is fully allocated.

### Pick

- A printable pick list per order shows location, SKU, lot, LPN, serials and qty, sorted by
  location.
- Confirming a pick moves stock to the Outbound Staging location the user chooses, and keeps it
  allocated to the order.
- **Short pick:** the user enters a lower quantity and the remainder is deallocated and logged.

### Shipment

- Confirming shipment removes picked stock from inventory and closes the order.
- Short quantities are recorded on the order.
- A shipment cannot be reversed. Returns are out of scope.
- Cancelling an order is allowed before shipment. It releases all allocations, and any picked
  stock stays in staging as available stock, ready to be moved back.

### Inventory adjustment and cycle count

- **Adjustment:** change a stock record's quantity up or down with a required reason code. It
  cannot go below `allocatedQty`.
- **Cycle count:** choose locations, enter counted quantities (including items found that were not
  expected), review variances, then post them as history entries of type `COUNT`.

## 7. Freeze

- Targets: SKU, location, lot or LPN.
- A freeze requires a reason. Freeze and release each record the operator and time.
- While a freeze is active, matching stock **cannot be received, put away, moved, allocated,
  picked, shipped, adjusted or counted**. Every blocked attempt shows which freeze blocked it and
  why.
- Viewing, searching and reporting still work, and frozen items show a clear badge everywhere.
- Stock that was allocated before the freeze stays allocated, and cannot be picked or shipped until
  release. Deallocation is allowed, so an order can be re-allocated from other stock.
- A freeze list shows active and past freezes, with search.

## 8. Search

- **Global search** in the header accepts SKU, description, barcode, lot, serial, LPN, Notice No.,
  Internal Order, scrap reason or location.
- The ASN list can be filtered by Notice No., Internal Order, scrap reason, order type, When, Who
  and status.
- **Where is it?** Results show every current location with qty, available, allocated, lot, expiry,
  LPN, Notice No., scrap reason, waiting days and frozen status. A serial shows its one location, or that it has shipped and on
  which order.
- **What's in this location?** A location view shows all contents with the same columns, can be
  filtered, and groups contents by LPN. It also shows the location's freeze status and links to its
  history.

## 9. Reports

All reports have filters and CSV export.

1. **Stock on hand:** by SKU, location, lot or LPN, showing on-hand, allocated, frozen and available.
2. **Daily activity:** received, put away, moved, picked and shipped by day, SKU or operator, as a
   table plus a simple bar chart drawn without a library. Receipts can also be filtered by order
   type (External or Internal).
3. **Location utilisation:** empty, used and frozen locations by zone, as counts and percentages.
4. **Waiting time:** units by age band (0-7, 8-30, 31-60, 61-90, over 90 days), plus the
   longest-waiting stock.

The Dashboard shows total SKUs, locations in use, on-hand units, open ASNs, open orders, active
freezes and the latest 10 transactions.

## 10. History

- History is append-only and can never be edited or deleted in the app. Corrections are made with
  new transactions.
- Each entry records: ID, timestamp, operator, type, SKU, lot, expiry, serials, LPN, Notice No.,
  scrap reason, from location, to location, qty, reference document and reason.
- Types: `RECEIVE`, `PUTAWAY`, `MOVE`, `ALLOCATE`, `DEALLOCATE`, `PICK`, `SHIP`, `ADJUST`, `COUNT`,
  `FREEZE`, `UNFREEZE`, plus `ASN_CREATE`, `ASN_CLOSE`, `ORDER_CREATE`, `ORDER_CANCEL`, and create,
  update, deactivate, activate and delete events for SKUs and locations.
- Filter by date range, type, operator, SKU, lot, serial, LPN, Notice No., scrap reason, location
  or order.
  Export as CSV.
- SKU, location, LPN and serial screens link to their filtered history.

## 11. Menu

| Group | Screens |
|---|---|
| Dashboard | Dashboard |
| Master Data | SKUs, Locations |
| Inbound | ASNs, Receive, Putaway |
| Inventory | Stock Search, Location View, Move, Adjust, Cycle Count, Freeze |
| Outbound | Orders, Allocate, Pick, Ship |
| Analysis | Reports, History |
| System | Settings (backup, import, demo data, reset) |

## 12. Out of scope

Multiple warehouses, login and roles, auto-allocation, wave picking, returns, multiple units of
measure, location capacity, expiry and low-stock reports, multi-device sync, and using the app in
several tabs at once.

## 13. Acceptance checks

Verify each of these in a browser before calling the work finished:

1. Refresh the page mid-session and all data is still there.
2. Export, reset, then import: all records and history match the original.
3. Importing an invalid JSON file changes nothing and shows an error.
4. Receive a lot, expiry and serial-controlled SKU against an ASN into a new LPN, partially then
   fully, and the ASN status updates correctly.
5. Put away the LPN, then search by serial, lot, LPN and Notice No.: each finds the right location.
6. Create an order, allocate across two locations by hand, pick and ship: stock falls by the right
   amount and the serial shows as shipped on that order.
7. A short pick releases the remainder and the shipment records the shortage.
8. Freezing a SKU, location, lot and LPN each blocks every listed transaction with a clear message.
   Release restores normal use.
9. Stock frozen after allocation cannot be picked until release, but can be deallocated.
10. No action can make a quantity negative or put one serial in stock twice.
11. For any SKU, on-hand stock equals the sum of its history entries.
12. The four reports match Stock Search, and their CSV files open correctly in Excel, including
    non-English text.
13. Text containing HTML, such as `<b>test</b>`, displays as plain text everywhere.
14. The card on the SpacePlayground home page opens the app, and Run Coach and Kindergarten 1's
    Games still work.
15. A duplicate Notice No. is rejected, and an ASN accepts exactly one SKU. Internal Order `357`
    and `380` give External, and `356`, `332` or any other code gives Internal.
16. Scrap reason and waiting days stay correct after putaway, moves and picks, and the Waiting time
    report totals match on-hand stock.
