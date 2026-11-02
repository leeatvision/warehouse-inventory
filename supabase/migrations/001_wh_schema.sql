-- Warehouse app: tables. Every object is new and prefixed wh_. Existing tables are only read (qbt_users,
-- qbt_jobcode_tree) and only inside the functions in 002. Tables have RLS on and no policies, so the
-- browser can reach data only through the wh_ functions, which check the device key.

create table wh_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table wh_user_prefs (
  user_id bigint primary key,            -- qbt_users.user_id (no foreign key, so qbt_users is untouched)
  role text not null default 'user' check (role in ('user','manager')),
  excluded boolean not null default false,
  pin_salt text, pin_hash text, pin_iter int,
  updated_at timestamptz not null default now()
);

create table wh_locations (
  id uuid primary key,
  parent_id uuid references wh_locations(id),
  name text not null,
  archived boolean not null default false,
  updated_at timestamptz not null default now()
);

create table wh_custom_fields (
  id uuid primary key,
  name text not null,
  ftype text not null check (ftype in ('text','number','date','bool','choice')),
  options jsonb not null default '[]',
  alert_days int,                        -- date fields: alert this many days before the date
  sort int not null default 0,
  archived boolean not null default false,
  updated_at timestamptz not null default now()
);

create sequence wh_item_no_c;
create sequence wh_item_no_e;

create table wh_items (
  id uuid primary key,                   -- made on the device, so offline entries can refer to new Items
  kind text not null check (kind in ('consumable','equipment')),
  number text unique,                    -- C-0001 / E-0001, given by the server, never changes
  name text not null,
  description text not null default '',
  location_id uuid references wh_locations(id),
  tags text[] not null default '{}',
  custom jsonb not null default '{}',
  low_stock numeric,
  counted boolean not null default false, -- Equipment: counted type (true) or individual piece (false)
  qty numeric not null default 0,        -- what the app believes is on the shelf
  status text not null default 'available'
    check (status in ('available','checked_out','in_repair','lost','retired')),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wh_item_photos (
  id uuid primary key,
  item_id uuid not null references wh_items(id),
  data text not null,                    -- small JPEG as a data URL
  created_at timestamptz not null default now()
);
create index on wh_item_photos (item_id);

create table wh_pos (
  id uuid primary key,
  number bigint generated always as identity,
  supplier text not null default '',
  status text not null default 'open' check (status in ('open','partial','received','cancelled')),
  lines jsonb not null default '[]',     -- [{item_id, qty, received}]
  note text not null default '',
  created_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per submission at the device. id is the Cart number shown to people.
create table wh_carts (
  id bigint generated always as identity primary key,
  client_id uuid not null unique,
  kind text not null check (kind in ('cart','correction','received','adjustment','supplier_return')),
  entered_by bigint not null,
  on_behalf_of bigint,
  branch text not null,
  note text not null default '',
  correction_of bigint references wh_carts(id),   -- for kind correction: the original Cart
  correction_seq int,
  correction_note text not null default '',
  cancelled boolean not null default false,
  po_id uuid references wh_pos(id),
  client_at timestamptz,
  received_at timestamptz not null default now()
);
create index on wh_carts (correction_of);
create index on wh_carts (received_at);

create table wh_lines (
  id bigint generated always as identity primary key,
  cart_id bigint not null references wh_carts(id),
  line_no int not null,
  kind text not null check (kind in ('take','return','checkout','checkin','received','adjust','supplier_return')),
  item_id uuid not null references wh_items(id),
  qty numeric not null,                  -- adjust: the new count; others: positive amount
  jobcode_id bigint,
  note text not null default '',
  link_line_id bigint references wh_lines(id),
  checkout_id uuid,
  reason text not null default '',
  count_is_off boolean not null default false
);
create index on wh_lines (cart_id);
create index on wh_lines (item_id);

create table wh_checkouts (
  id uuid primary key,
  item_id uuid not null references wh_items(id),
  user_id bigint not null,
  jobcode_id bigint,
  qty numeric not null,
  qty_returned numeric not null default 0,
  opened_cart bigint references wh_carts(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on wh_checkouts (item_id) where closed_at is null;

-- Every change to a count or a location, for reports.
create table wh_ledger (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  cart_id bigint references wh_carts(id),
  item_id uuid not null references wh_items(id),
  delta numeric not null default 0,
  qty_after numeric,
  kind text not null,
  user_id bigint,
  on_behalf_of bigint,
  jobcode_id bigint,
  from_location uuid,
  to_location uuid,
  note text not null default ''
);
create index on wh_ledger (at);
create index on wh_ledger (item_id, at);

-- Everything anyone did, for the activity report.
create table wh_activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id bigint,
  action text not null,
  target text not null default '',
  detail jsonb not null default '{}'
);
create index on wh_activity (at);

-- Every operation the device sent, by its device-made id, so a resend is never applied twice.
create table wh_ops (
  client_id uuid primary key,
  op text not null,
  user_id bigint,
  received_at timestamptz not null default now(),
  result jsonb
);

create table wh_pick_lists (
  id uuid primary key,
  name text not null,
  jobcode_id bigint,
  lines jsonb not null default '[]',     -- [{item_id, qty, picked}]
  status text not null default 'open' check (status in ('open','done','cancelled')),
  cart_id bigint references wh_carts(id),
  created_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wh_counts (
  id uuid primary key,
  name text not null,
  location_ids jsonb not null default '[]',
  assigned_to bigint,
  lines jsonb not null default '[]',     -- [{item_id, expected, counted}]
  status text not null default 'open' check (status in ('open','submitted','applied','cancelled')),
  cart_id bigint references wh_carts(id),
  created_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wh_saved_reports (
  id uuid primary key,
  name text not null,
  kind text not null,
  filters jsonb not null default '{}',
  created_by bigint,
  updated_at timestamptz not null default now()
);

-- Billing documents in Drive: one per original Cart and Job code. id is the D number.
create table wh_docs (
  id bigint generated always as identity primary key,
  cart_id bigint not null references wh_carts(id),
  jobcode_id bigint not null,
  vtype text not null check (vtype in ('T','C')),
  vno int not null default 1,
  revision int not null default 1,
  delivered_revision int not null default 0,
  cancelled boolean not null default false,
  last_edit_at timestamptz not null default now(),
  drive_file_id text,
  file_name text,
  delivered_at timestamptz,
  last_error text,
  unique (cart_id, jobcode_id)
);

do $$
declare t text;
begin
  foreach t in array array['wh_settings','wh_user_prefs','wh_locations','wh_custom_fields','wh_items',
    'wh_item_photos','wh_pos','wh_carts','wh_lines','wh_checkouts','wh_ledger','wh_activity','wh_ops',
    'wh_pick_lists','wh_counts','wh_saved_reports','wh_docs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence wh_item_no_c, wh_item_no_e from anon, authenticated;
