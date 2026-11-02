# Warehouse app v1: feature list

What the first version of the warehouse app does. Written 2026-11-01.

## Scope

- **One Branch** for v1. The app is built so a second Branch can be added later, but v1 shows only one: one Job code list, one billing destination.
- **Users** are the active QuickBooks Time users for that Branch, minus a short exclusion list. The list itself is private (kept in the brand repo, not here).
- **Starting point:** the feature set of a typical mid-to-upper-tier inventory product (see [How this list was made](#how-this-list-was-made)), minus the features listed under [Left out](#left-out), plus what our warehouse needs that such products don't do (Job code billing).
- Words in **bold** are terms from the glossary in `CONTEXT.md`.

## Features in v1

### Catalogue

| # | Feature | What it does here |
|---|---|---|
| 1 | Items | Every **Item** is a **Consumable** or **Equipment**, with a permanent **Item number** (C-0042, E-0007). Items are archived, never deleted. |
| 2 | Spreadsheet import | A Manager uploads a CSV of the existing parts list to create Items in one go, with a preview and an error list before anything is saved. |
| 3 | Photos | One or more photos per Item, taken with the tablet camera or uploaded. Shown in search results so people pick the right part. |
| 4 | Catalogue list | Search by name, Item number, tag or custom field. Filter by location, tag, type and stock status. Sort by name, count or last change. |
| 5 | Locations | Nested places in the warehouse (Area, then Shelf, then Bin). Every Item has a home location; Equipment that is checked out shows who has it instead. |
| 6 | Tags | Free labels across locations (e.g. "EV", "service van stock"). |
| 7 | Custom fields | Managers add their own fields to Items (supplier part number, manufacturer, cost, calibration due). Types: text, number, date, yes/no, pick-list. No fixed limit. |
| 8 | Units of measure | Each, ft, box, roll, spool, plus Manager-defined units. Quantities can be decimal where the unit allows (e.g. 12.5 ft). |

### Day-to-day use

| # | Feature | What it does here |
|---|---|---|
| 9 | Barcode and QR scanning | Scan with the tablet camera, or with a plug-in or Bluetooth scanner (these type like a keyboard). Scanning an Item label opens it or adds it to the **Cart**. |
| 10 | Label printing | Make QR and barcode labels for Items and locations from the Item number. Printable sheets for standard label stock; single labels for a label printer. |
| 11 | **Take out** and **Return** | The core flow. A **User** builds a **Cart**, gives each line a **Job code** (or one for the whole Cart), checks it on a review screen and saves. |
| 12 | **Check-out** and check-in | Equipment leaves with a named User for a Job code and comes back, whole or (for counted Equipment) in parts. The catalogue shows who has it, since when, and for which job. |
| 13 | Jobs view | Pick a Job code to see everything taken out, returned and still checked out for it. The same data feeds **Material usage** billing. |
| 14 | Pick lists | A Manager prepares a list of Items for a job ahead of time. Whoever picks it ticks lines off at the shelf; finishing the pick turns it into a Take out Cart for that Job code. |
| 15 | Purchase orders | A Manager makes a PO for a supplier from catalogue Items (quantity, cost), exports it as PDF or CSV, then records **Received** against it, including partial deliveries. |
| 16 | Stock counts | A Manager starts a count for some or all locations and assigns it. Counters enter what is on the shelf; differences become **Adjustments** with the reason "recount". |
| 17 | **Supplier return** and **Adjustment** | As in the glossary: Manager-only, reason required. |
| 18 | **Correction** | A User can fix their own Carts from the last 2 weeks. The original stays on record. |
| 19 | **Equipment status** | Available, Checked out, In Repair, Lost, Retired. |

### Alerts (in the app only)

| # | Feature | What it does here |
|---|---|---|
| 20 | Low stock | Each Item can have a low-stock level. Items at or below it show on a Manager alert list and a badge. |
| 21 | Date alerts | Alerts on any date field: Equipment due back, maintenance or calibration due, warranty end. |
| 22 | **Count is off** | Raised when a Take out is more than the app thinks is on the shelf. The entry is still accepted. |
| 23 | Overdue Equipment | Check-outs open longer than a Manager-set number of days. |

### Working offline and in sync

| # | Feature | What it does here |
|---|---|---|
| 24 | Offline | The tablet keeps working with no internet: catalogue, recent Job codes, Users and PINs are kept on the device. Entries wait in a queue and send themselves when the connection comes back. |
| 25 | Sync across devices | The tablet, Managers' phones and the office computer see the same data within seconds when online. |

### Reports

All reports can be filtered by date range, User, Job code, location and tag, and exported as CSV or PDF. History is kept for as long as the app exists (no 1- or 3-year cut-off).

| # | Report | Shows |
|---|---|---|
| 26 | Activity history | Every change: who, what, when, and before and after values. |
| 27 | Stock summary | Quantity and value on hand, by location or tag. |
| 28 | User activity | What each User took out, returned, checked out and corrected in a period. |
| 29 | Low stock | Everything at or below its low-stock level, with how many to reorder. |
| 30 | Moves | Items moved between locations. |
| 31 | Item flow | All quantity changes for chosen Items over a period, with a running count. |
| 32 | Transactions | Every Take out, Return, Received, Adjustment and Supplier return. |
| 33 | Saved reports | Save a report's filters and columns under a name to re-run later. |

### People and access

| # | Feature | What it does here |
|---|---|---|
| 34 | Users from QuickBooks Time | The User list is read (never written) from the QuickBooks Time copy already in the database. New hires appear automatically; people who leave disappear. A private exclusion list removes specific people. |
| 35 | PIN sign-in | Each User signs in on the shared tablet with a PIN. **On behalf of** entries record both names. |
| 36 | Roles | Two built-in roles, **User** and **Manager**. A Manager can make extra roles by switching individual rights on or off (e.g. "can receive deliveries but not adjust counts"). |

### Billing (our addition)

| # | Feature | What it does here |
|---|---|---|
| 37 | **Material usage** | Take outs (and Returns and Supplier returns as credits) for each Job code are delivered as billing files to the Branch's billing destination. Corrections are delivered marked as corrections. How files reach that destination is an open question, below. |

## Left out

| Left out | Why |
|---|---|
| Team messaging and comments on Items | Not wanted |
| Email alerts, and reports sent by email on a schedule | Not wanted. Alerts stay in the app. |
| Accounting, chat and storefront integrations; online ordering through a retailer; public API and webhooks | Not wanted. The only outside systems are the ones we already use: Job codes and Users come from the existing QuickBooks Time copy in the database. |
| Single sign-on | Not wanted |
| Managing several separate accounts from one dashboard | Not wanted. There is one company. |
| Cheaper "limited" seats | Not relevant. We don't sell seats. |
| Fixed limits on Items, Users, active jobs or custom fields | Not relevant for the same reason |
| A second Branch | Later. v1 is one Branch. |

## Open questions

1. **Billing delivery.** Earlier research proposed a Google Apps Script that copies billing files to Google Drive. That is an outside connection; is it still wanted, or should a Manager download the billing CSV from the app instead?
2. **Tablet screens.** The questions from the screen prototype are still open: which layout, whether Take out and Return share one Cart, name plus PIN or PIN only, and when the tablet signs out.
3. **Custom roles.** Needed in v1, or are User and Manager enough to start?
4. **Label printer.** Which printer and label size, if one is bought.
5. **Costs and values.** Should Items carry a cost so the stock summary can show money values, and who may see them?

## How this list was made

- Sources used: the public pricing comparison table and public features page of a well-known inventory product (sortly.com, read 2026-11-01), plus our own glossary and earlier research.
- Not used: anything behind a login, trial accounts, network recordings (HAR files), the product's code, screenshots or screen layouts. Its terms forbid building a similar service from account-only material and copying its look and feel.
- The tier used as the reference was the one below enterprise. Its features were checked one by one against the exclusion list above. Descriptions here are our own and describe our app, not theirs.
