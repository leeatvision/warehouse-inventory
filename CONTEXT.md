# Warehouse Tracker

The shared stock of parts and equipment in the company warehouse, and who takes what out for which job.

## Language

### Things

**Stock**:
The single pool of items held in the warehouse, shared by both companies.
_Avoid_: Inventory per company

**Item**:
Anything in the catalogue: a Consumable or a piece/type of Equipment. Every Item has a permanent Item number that never changes, even if its name does; Items are archived, never deleted.
_Avoid_: SKU, product

**Item number**:
The short permanent number the app gives each Item (e.g. C-0042 for a Consumable, E-0007 for Equipment).
_Avoid_: Barcode (none exist yet), part number (that is the supplier's)

**Consumable**:
An Item used up on a job (wire, conduit, connectors). Counted by quantity; once taken out it is not expected back, and it is billable on T&M jobs.
_Avoid_: Part (when equipment is meant), material

**Equipment**:
A durable company resource that is checked out and expected back (32-ft A-frame ladder, scaffolding, tools). Each Equipment Item is set up either as an individual piece or as a counted type (e.g. 12 scaffold frames).
_Avoid_: Asset, tool (too narrow)

**Equipment status**:
Where a piece of Equipment stands: Available, Checked out, In Repair, Lost, or Retired. In Repair, Lost and Retired are set by a Manager and never involve a Job code or billing.

**Job code**:
A QuickBooks Time job code, the unit work is charged to (e.g. "Customer => Job"). Never created or edited by this app; the tablet keeps a recent copy of the list so it can work offline.
_Avoid_: Job number, project

### People

**User**:
A person who identifies themselves at the shared tablet with a PIN, so every entry is attributed to them.
_Avoid_: Employee (not all Users may be employees), account

**Manager**:
A User with extra rights: maintain the catalogue, record Received deliveries, make Adjustments, set Equipment status, set PINs, enter on behalf of another User, see alerts and reports.

**Branch**:
A billing company the warehouse serves, identified by a short code. Branches share one Stock but never bill together. Version 1 serves a single Branch; its code and name are settings in the database, not in this repo.
_Avoid_: Company (ambiguous), division

### Entries

**Cart**:
One submission at the tablet: one User (or a Manager on behalf of a named User), one Branch, any number of lines. Each line has its own Job code by default, or one Job code is applied to the whole Cart. Confirmed on a review screen before it is saved.
_Avoid_: Order, transaction

**Take out**:
A Cart line taking a Consumable from Stock for a Job code. Goes to billing.

**Return**:
A Consumable coming back from a Job code into Stock. Always names a Job code and always goes to billing as a credit (negative quantity). Normally linked to the Take out it comes from, which may have been made by a different User.

**Supplier return**:
A Manager recording Consumables from a Job code going straight back to the supplier, never re-entering the warehouse. Always names a Job code and bills as a credit like a Return, but does not change Stock. May link to the original Take out.
_Avoid_: Return (that puts material back into Stock)

**Received**:
A Manager recording a supplier delivery into Stock, with a PO number. Never goes to billing.
_Avoid_: Purchase, order

**Adjustment**:
A Manager's change to a Stock count, with a required reason (initial count, recount found more or fewer, damaged and thrown away). Never goes to billing.
_Avoid_: Correction (that is a User fixing their own Cart)

**Check-out**:
Equipment leaving the warehouse with a named User for a named Job code; the catalogue shows "Checked out by [User] on [date] for [Job code]" until it is returned. Counted Equipment may be returned in parts. Never sent to billing.

**Material usage**:
The billing record of Take outs and Returns for a Job code, delivered to the Cart's Branch billing destination.
_Avoid_: Usage report, pick list

**Correction**:
A User's change to one of their own Carts from the last 2 weeks: change quantities, parts or Job codes, add or remove lines, or cancel it. The original is never altered; the Correction is a new record, and if billing was affected it is delivered marked unmistakably as a correction.
_Avoid_: Edit (implies overwriting)

**On behalf of**:
A Manager entering a Cart for another named User who is not at the tablet. Both names are kept; the Cart's Branch defaults to the named User's home Branch.

**Count is off**:
The flag raised when a Take out exceeds what the app believes is in Stock. The entry is still accepted; Managers are asked to recount.
