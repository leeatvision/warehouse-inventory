-- Warehouse app: functions. The browser calls only the wh_ functions granted to anon at the bottom.
-- Secrets live in Vault: wh_device_key (typed into each device once) and wh_delivery_token (Apps Script).

create or replace function wh__secret_ok(p_name text, p_value text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_value, '') <> '' and exists (
    select 1 from vault.decrypted_secrets where name = p_name and decrypted_secret = p_value)
$$;

create or replace function wh__require_key(p_key text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not wh__secret_ok('wh_device_key', p_key) then
    raise exception 'wh: device key not accepted' using errcode = '28000';
  end if;
end $$;

create or replace function wh__setting(p_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select value from wh_settings where key = p_key
$$;

-- People who may use the app: active QuickBooks Time users, minus the exclusion list.
create or replace function wh__people() returns table (user_id bigint, name text, role text,
  pin_salt text, pin_hash text, pin_iter int)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.user_id, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')),
         coalesce(p.role, 'user'), p.pin_salt, p.pin_hash, p.pin_iter
  from qbt_users u left join wh_user_prefs p on p.user_id = u.user_id
  where u.active and not coalesce(p.excluded, false)
$$;

create or replace function wh__name(p_user bigint) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) from qbt_users where user_id = p_user
$$;

create or replace function wh__role(p_user bigint) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r text;
begin
  select role into r from wh__people() where user_id = p_user;
  if r is null then raise exception 'wh: unknown or inactive user %', p_user; end if;
  return r;
end $$;

create or replace function wh__require_manager(p_user bigint) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if wh__role(p_user) <> 'manager' then raise exception 'wh: only a Manager can do this'; end if;
end $$;

create or replace function wh__log(p_user bigint, p_action text, p_target text, p_detail jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into wh_activity (user_id, action, target, detail) values (p_user, p_action, coalesce(p_target,''), coalesce(p_detail,'{}'))
$$;

-- Change an Item's shelf count and record it in the ledger.
create or replace function wh__move_qty(p_item uuid, p_delta numeric, p_kind text, p_cart bigint, p_user bigint,
  p_obo bigint, p_job bigint, p_note text) returns numeric
language plpgsql security definer set search_path = public, pg_temp as $$
declare q numeric;
begin
  update wh_items set qty = qty + p_delta, updated_at = now() where id = p_item returning qty into q;
  if q is null then raise exception 'wh: unknown item %', p_item; end if;
  insert into wh_ledger (cart_id, item_id, delta, qty_after, kind, user_id, on_behalf_of, jobcode_id, note)
  values (p_cart, p_item, p_delta, q, p_kind, p_user, p_obo, p_job, coalesce(p_note,''));
  return q;
end $$;

-- The current Take out / Return lines of an original Cart (after its latest Correction).
create or replace function wh__cart_state(p_root bigint) returns table (kind text, item_id uuid, qty numeric,
  jobcode_id bigint, note text, line_no int)
language sql stable security definer set search_path = public, pg_temp as $$
  with src as (
    select coalesce((select id from wh_carts where correction_of = p_root order by correction_seq desc limit 1), p_root) as cid)
  select l.kind, l.item_id, l.qty, l.jobcode_id, l.note, l.line_no
  from wh_lines l, src where l.cart_id = src.cid and l.kind in ('take','return')
$$;

create or replace function wh__cart_note(p_root bigint) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select note from wh_carts where correction_of = p_root order by correction_seq desc limit 1),
                  (select note from wh_carts where id = p_root))
$$;

-- A Job code's Take out lines in a state, as a comparable value.
create or replace function wh__job_sig(p_lines jsonb, p_job bigint) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_array(x->>'item_id', (x->>'qty')::numeric, coalesce(x->>'note',''))
           order by x->>'item_id', (x->>'qty')::numeric, coalesce(x->>'note','')), '[]')
  from jsonb_array_elements(p_lines) x
  where x->>'kind' = 'take' and (x->>'jobcode_id')::bigint = p_job
$$;

-- Insert lines of a Cart and apply their effect on the shelf.
create or replace function wh__apply_lines(p_cart bigint, p_lines jsonb, p_user bigint, p_obo bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  x jsonb; n int := 0; k text; it wh_items; q numeric; after numeric; co uuid; c wh_checkouts; job bigint;
begin
  for x in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    n := n + 1;
    k := x->>'kind';
    q := (x->>'qty')::numeric;
    job := nullif(x->>'jobcode_id','')::bigint;
    select * into it from wh_items where id = (x->>'item_id')::uuid;
    if it.id is null then raise exception 'wh: unknown item %', x->>'item_id'; end if;
    if q is null or q < 0 or (q = 0 and k <> 'adjust') then raise exception 'wh: bad quantity for %', it.number; end if;
    co := null;
    if k in ('take','return','supplier_return') and job is null then
      raise exception 'wh: % needs a Job code', it.number;
    end if;
    if k = 'take' then
      if it.kind <> 'consumable' then raise exception 'wh: % is Equipment; use Check-out', it.number; end if;
      after := wh__move_qty(it.id, -q, 'take', p_cart, p_user, p_obo, job, x->>'note');
    elsif k = 'return' then
      after := wh__move_qty(it.id, q, 'return', p_cart, p_user, p_obo, job, x->>'note');
    elsif k = 'received' then
      after := wh__move_qty(it.id, q, 'received', p_cart, p_user, p_obo, job, x->>'note');
    elsif k = 'adjust' then
      after := wh__move_qty(it.id, q - it.qty, 'adjust', p_cart, p_user, p_obo, null, x->>'reason');
    elsif k = 'supplier_return' then
      null; -- billed as a credit later; never re-enters the warehouse
    elsif k = 'checkout' then
      if it.kind <> 'equipment' then raise exception 'wh: % is not Equipment', it.number; end if;
      if not it.counted then
        if it.status <> 'available' then raise exception 'wh: % is not available', it.number; end if;
        q := 1;
        update wh_items set status = 'checked_out', qty = 0, updated_at = now() where id = it.id;
        insert into wh_ledger (cart_id, item_id, delta, qty_after, kind, user_id, on_behalf_of, jobcode_id)
          values (p_cart, it.id, -1, 0, 'checkout', p_user, p_obo, job);
      else
        after := wh__move_qty(it.id, -q, 'checkout', p_cart, p_user, p_obo, job, x->>'note');
      end if;
      co := coalesce(nullif(x->>'checkout_id','')::uuid, gen_random_uuid());
      insert into wh_checkouts (id, item_id, user_id, jobcode_id, qty, opened_cart)
        values (co, it.id, coalesce(p_obo, p_user), job, q, p_cart);
    elsif k = 'checkin' then
      select * into c from wh_checkouts where id = (x->>'checkout_id')::uuid;
      if c.id is null then raise exception 'wh: unknown check-out for %', it.number; end if;
      if c.closed_at is not null then raise exception 'wh: % was already checked in', it.number; end if;
      q := least(q, c.qty - c.qty_returned);
      co := c.id;
      update wh_checkouts set qty_returned = qty_returned + q,
        closed_at = case when qty_returned + q >= qty then now() end where id = c.id;
      if not it.counted then
        update wh_items set status = 'available', qty = 1, updated_at = now() where id = it.id;
        insert into wh_ledger (cart_id, item_id, delta, qty_after, kind, user_id, on_behalf_of, jobcode_id)
          values (p_cart, it.id, 1, 1, 'checkin', p_user, p_obo, c.jobcode_id);
      else
        after := wh__move_qty(it.id, q, 'checkin', p_cart, p_user, p_obo, c.jobcode_id, x->>'note');
      end if;
      job := c.jobcode_id;
    else
      raise exception 'wh: unknown line kind %', k;
    end if;
    insert into wh_lines (cart_id, line_no, kind, item_id, qty, jobcode_id, note, link_line_id, checkout_id, reason, count_is_off)
    values (p_cart, n, k, it.id, q, job, coalesce(x->>'note',''), nullif(x->>'link_line_id','')::bigint, co,
            coalesce(x->>'reason',''), k = 'take' and after < 0);
  end loop;
end $$;

-- One operation sent by a device.
create or replace function wh__apply_op(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  op text := p->>'op';
  u bigint := nullif(p->>'user_id','')::bigint;
  d jsonb := coalesce(p->'data', '{}');
  obo bigint := nullif(d->>'on_behalf_of','')::bigint;
  branch text := coalesce(wh__setting('branch')->>'code', '');
  cid bigint; root wh_carts; prev jsonb; nxt jsonb; prev_note text; seq int; j bigint; dd wh_docs;
  changed boolean; x jsonb; v_id uuid; num text; it wh_items; po wh_pos; cnt wh_counts; r jsonb;
begin
  if op = 'user_save' and u is null then
    -- First-time setup only: allowed while no Manager has a PIN yet.
    if exists (select 1 from wh__people() where role = 'manager' and pin_hash is not null) then
      raise exception 'wh: a Manager must be signed in';
    end if;
  else
    perform wh__role(u);
  end if;

  if op = 'cart' then
    if obo is not null then perform wh__require_manager(u); perform wh__role(obo); end if;
    insert into wh_carts (client_id, kind, entered_by, on_behalf_of, branch, note, client_at)
      values ((p->>'client_id')::uuid, 'cart', u, obo, branch, coalesce(d->>'note',''), nullif(p->>'at','')::timestamptz)
      returning wh_carts.id into cid;
    perform wh__apply_lines(cid, d->'lines', u, obo);
    insert into wh_docs (cart_id, jobcode_id, vtype, vno)
      select distinct cid, jobcode_id, 'T', 1 from wh_lines where cart_id = cid and kind = 'take';
    if d->>'pick_id' is not null then
      update wh_pick_lists set status = 'done', cart_id = cid, updated_at = now() where id = (d->>'pick_id')::uuid;
    end if;
    perform wh__log(u, 'cart', cid::text, jsonb_build_object('on_behalf_of', obo, 'lines', jsonb_array_length(coalesce(d->'lines','[]'))));
    return jsonb_build_object('cart_id', cid);

  elsif op = 'correction' then
    select * into root from wh_carts where wh_carts.id = (d->>'cart_id')::bigint and kind = 'cart';
    if root.id is null then raise exception 'wh: Cart not found'; end if;
    if u not in (root.entered_by, coalesce(root.on_behalf_of, -1)) then perform wh__require_manager(u); end if;
    if root.received_at < now() - interval '14 days' then raise exception 'wh: Cart % is older than 2 weeks', root.id; end if;
    select coalesce(jsonb_agg(to_jsonb(s)), '[]') into prev from wh__cart_state(root.id) s;
    prev_note := wh__cart_note(root.id);
    if exists (select 1 from wh_carts where correction_of = root.id and cancelled) then
      raise exception 'wh: Cart % was cancelled', root.id;
    end if;
    nxt := case when (d->>'cancel')::boolean then '[]'::jsonb else coalesce(d->'lines','[]') end;
    if exists (select 1 from jsonb_array_elements(nxt) e where e->>'kind' not in ('take','return')) then
      raise exception 'wh: a Correction can only change Take outs and Returns';
    end if;
    select coalesce(max(correction_seq), 0) + 1 into seq from wh_carts where correction_of = root.id;
    insert into wh_carts (client_id, kind, entered_by, on_behalf_of, branch, note, correction_of, correction_seq,
                          correction_note, cancelled, client_at)
      values ((p->>'client_id')::uuid, 'correction', u, root.on_behalf_of, root.branch,
              case when d ? 'note' then coalesce(d->>'note','') else prev_note end, root.id, seq,
              coalesce(d->>'correction_note',''), coalesce((d->>'cancel')::boolean, false), nullif(p->>'at','')::timestamptz)
      returning wh_carts.id into cid;
    -- Undo the previous state's effect on the shelf, then apply the new one, as one net change per Item.
    for x in
      select jsonb_build_object('item_id', item_id, 'delta', sum(delta)) from (
        select (e->>'item_id')::uuid item_id, case when e->>'kind' = 'take' then (e->>'qty')::numeric else -(e->>'qty')::numeric end delta
          from jsonb_array_elements(prev) e
        union all
        select (e->>'item_id')::uuid, case when e->>'kind' = 'take' then -(e->>'qty')::numeric else (e->>'qty')::numeric end
          from jsonb_array_elements(nxt) e) t
      group by item_id having sum(delta) <> 0
    loop
      perform wh__move_qty((x->>'item_id')::uuid, (x->>'delta')::numeric, 'correction', cid, u, root.on_behalf_of, null,
                           'Correction ' || seq || ' of Cart ' || root.id);
    end loop;
    insert into wh_lines (cart_id, line_no, kind, item_id, qty, jobcode_id, note)
      select cid, row_number() over (), e->>'kind', (e->>'item_id')::uuid, (e->>'qty')::numeric,
             nullif(e->>'jobcode_id','')::bigint, coalesce(e->>'note','')
      from jsonb_array_elements(nxt) e;
    if exists (select 1 from wh_lines where cart_id = cid and (qty <= 0 or jobcode_id is null)) then
      raise exception 'wh: every line needs a quantity and a Job code';
    end if;
    -- Re-issue the billing document of every Job code this Correction touches.
    for j in
      select distinct (e->>'jobcode_id')::bigint from jsonb_array_elements(prev || nxt) e where e->>'kind' = 'take'
    loop
      changed := (d->>'cancel')::boolean is true
        or wh__job_sig(prev, j) <> wh__job_sig(nxt, j)
        or coalesce(prev_note,'') <> coalesce((select note from wh_carts where wh_carts.id = cid),'');
      if changed then
        select * into dd from wh_docs where cart_id = root.id and jobcode_id = j;
        if dd.id is null then
          insert into wh_docs (cart_id, jobcode_id, vtype, vno, cancelled) values (root.id, j, 'C', 1, coalesce((d->>'cancel')::boolean,false));
        else
          update wh_docs set vtype = 'C', vno = case when vtype = 'T' then 1 else vno + 1 end,
            revision = revision + 1, last_edit_at = now(), cancelled = coalesce((d->>'cancel')::boolean,false)
          where wh_docs.id = dd.id;
        end if;
      end if;
    end loop;
    perform wh__log(u, 'correction', root.id::text, jsonb_build_object('seq', seq, 'cancel', (d->>'cancel')::boolean));
    return jsonb_build_object('cart_id', cid, 'correction_of', root.id, 'seq', seq);

  elsif op in ('received','adjustment','supplier_return') then
    perform wh__require_manager(u);
    insert into wh_carts (client_id, kind, entered_by, on_behalf_of, branch, note, po_id, client_at)
      values ((p->>'client_id')::uuid, op, u, obo, branch, coalesce(d->>'note',''), nullif(d->>'po_id','')::uuid,
              nullif(p->>'at','')::timestamptz)
      returning wh_carts.id into cid;
    perform wh__apply_lines(cid, (select jsonb_agg(e || jsonb_build_object('kind',
      case op when 'received' then 'received' when 'adjustment' then 'adjust' else 'supplier_return' end))
      from jsonb_array_elements(coalesce(d->'lines','[]')) e), u, obo);
    if op = 'received' and d->>'po_id' is not null then
      select * into po from wh_pos where wh_pos.id = (d->>'po_id')::uuid;
      update wh_pos set lines = (
          select jsonb_agg(pl || jsonb_build_object('received', coalesce((pl->>'received')::numeric,0) + coalesce((
            select sum((e->>'qty')::numeric) from jsonb_array_elements(d->'lines') e where e->>'item_id' = pl->>'item_id'),0)))
          from jsonb_array_elements(po.lines) pl),
        updated_at = now()
        where wh_pos.id = po.id;
      update wh_pos set status = case when not exists (select 1 from jsonb_array_elements(lines) pl
          where coalesce((pl->>'received')::numeric,0) < (pl->>'qty')::numeric) then 'received' else 'partial' end
        where wh_pos.id = po.id;
    end if;
    if op = 'adjustment' and d->>'count_id' is not null then
      update wh_counts set status = 'applied', cart_id = cid, updated_at = now() where wh_counts.id = (d->>'count_id')::uuid;
    end if;
    perform wh__log(u, op, cid::text, '{}');
    return jsonb_build_object('cart_id', cid);

  elsif op = 'item_save' then
    perform wh__require_manager(u);
    v_id := (d->>'id')::uuid;
    select * into it from wh_items where wh_items.id = v_id;
    if it.id is null then
      num := case when d->>'kind' = 'equipment' then 'E-' || lpad(nextval('wh_item_no_e')::text, 4, '0')
                  else 'C-' || lpad(nextval('wh_item_no_c')::text, 4, '0') end;
      insert into wh_items (id, kind, number, name, description, location_id, tags, custom, low_stock, counted, qty)
      values (v_id, d->>'kind', num, d->>'name', coalesce(d->>'description',''), nullif(d->>'location_id','')::uuid,
              coalesce((select array_agg(t) from jsonb_array_elements_text(d->'tags') t), '{}'),
              coalesce(d->'custom','{}'), nullif(d->>'low_stock','')::numeric, coalesce((d->>'counted')::boolean,false),
              case when d->>'kind' = 'equipment' and not coalesce((d->>'counted')::boolean,false) then 1 else 0 end);
      perform wh__log(u, 'item_add', num, jsonb_build_object('name', d->>'name'));
    else
      if it.location_id is distinct from nullif(d->>'location_id','')::uuid then
        insert into wh_ledger (item_id, delta, qty_after, kind, user_id, from_location, to_location)
          values (it.id, 0, it.qty, 'move', u, it.location_id, nullif(d->>'location_id','')::uuid);
      end if;
      update wh_items set name = d->>'name', description = coalesce(d->>'description',''),
        location_id = nullif(d->>'location_id','')::uuid,
        tags = coalesce((select array_agg(t) from jsonb_array_elements_text(d->'tags') t), '{}'),
        custom = coalesce(d->'custom','{}'), low_stock = nullif(d->>'low_stock','')::numeric,
        archived = coalesce((d->>'archived')::boolean, false), updated_at = now()
      where wh_items.id = it.id;
      num := it.number;
      perform wh__log(u, 'item_edit', num, d - 'custom');
    end if;
    return jsonb_build_object('number', num);

  elsif op = 'equipment_status' then
    perform wh__require_manager(u);
    select * into it from wh_items where wh_items.id = (d->>'item_id')::uuid;
    if it.counted or it.kind <> 'equipment' then raise exception 'wh: status applies to individual Equipment'; end if;
    if it.status = 'checked_out' then raise exception 'wh: % is checked out; check it in first', it.number; end if;
    update wh_items set status = d->>'status', qty = case when d->>'status' = 'available' then 1 else 0 end,
      updated_at = now() where wh_items.id = it.id;
    insert into wh_ledger (item_id, delta, qty_after, kind, user_id, note)
      values (it.id, (case when d->>'status' = 'available' then 1 else 0 end) - it.qty,
              case when d->>'status' = 'available' then 1 else 0 end, 'status', u, d->>'status');
    perform wh__log(u, 'equipment_status', it.number, jsonb_build_object('status', d->>'status', 'note', d->>'note'));
    return '{}';

  elsif op = 'photo_add' then
    perform wh__require_manager(u);
    insert into wh_item_photos (id, item_id, data) values ((d->>'id')::uuid, (d->>'item_id')::uuid, d->>'data');
    return '{}';
  elsif op = 'photo_delete' then
    perform wh__require_manager(u);
    delete from wh_item_photos where wh_item_photos.id = (d->>'id')::uuid;
    return '{}';

  elsif op = 'location_save' then
    perform wh__require_manager(u);
    insert into wh_locations (id, parent_id, name, archived)
      values ((d->>'id')::uuid, nullif(d->>'parent_id','')::uuid, d->>'name', coalesce((d->>'archived')::boolean,false))
      on conflict (id) do update set parent_id = excluded.parent_id, name = excluded.name, archived = excluded.archived, updated_at = now();
    perform wh__log(u, 'location_save', d->>'name', '{}');
    return '{}';

  elsif op = 'field_save' then
    perform wh__require_manager(u);
    insert into wh_custom_fields (id, name, ftype, options, alert_days, sort, archived)
      values ((d->>'id')::uuid, d->>'name', d->>'ftype', coalesce(d->'options','[]'), nullif(d->>'alert_days','')::int,
              coalesce((d->>'sort')::int,0), coalesce((d->>'archived')::boolean,false))
      on conflict (id) do update set name = excluded.name, ftype = excluded.ftype, options = excluded.options,
        alert_days = excluded.alert_days, sort = excluded.sort, archived = excluded.archived, updated_at = now();
    perform wh__log(u, 'field_save', d->>'name', '{}');
    return '{}';

  elsif op = 'user_save' then
    if u is not null then perform wh__require_manager(u); end if;
    if not exists (select 1 from qbt_users where user_id = (d->>'user_id')::bigint) then raise exception 'wh: unknown user'; end if;
    if u is not null and u = (d->>'user_id')::bigint and d->>'role' = 'user' then
      raise exception 'wh: you cannot remove your own Manager role';
    end if;
    insert into wh_user_prefs (user_id, role, excluded, pin_salt, pin_hash, pin_iter)
      values ((d->>'user_id')::bigint, coalesce(d->>'role','user'), coalesce((d->>'excluded')::boolean,false),
              d->>'pin_salt', d->>'pin_hash', nullif(d->>'pin_iter','')::int)
      on conflict (user_id) do update set
        role = coalesce(d->>'role', wh_user_prefs.role),
        excluded = coalesce((d->>'excluded')::boolean, wh_user_prefs.excluded),
        pin_salt = case when d ? 'pin_hash' then d->>'pin_salt' else wh_user_prefs.pin_salt end,
        pin_hash = case when d ? 'pin_hash' then d->>'pin_hash' else wh_user_prefs.pin_hash end,
        pin_iter = case when d ? 'pin_hash' then nullif(d->>'pin_iter','')::int else wh_user_prefs.pin_iter end,
        updated_at = now();
    perform wh__log(u, 'user_save', wh__name((d->>'user_id')::bigint),
      jsonb_build_object('role', d->>'role', 'excluded', d->>'excluded', 'pin_changed', d ? 'pin_hash'));
    return '{}';

  elsif op = 'pick_save' then
    perform wh__require_manager(u);
    insert into wh_pick_lists (id, name, jobcode_id, lines, status, created_by)
      values ((d->>'id')::uuid, d->>'name', nullif(d->>'jobcode_id','')::bigint, coalesce(d->'lines','[]'), coalesce(d->>'status','open'), u)
      on conflict (id) do update set name = excluded.name, jobcode_id = excluded.jobcode_id, lines = excluded.lines,
        status = excluded.status, updated_at = now();
    perform wh__log(u, 'pick_save', d->>'name', '{}');
    return '{}';
  elsif op = 'pick_progress' then
    update wh_pick_lists set lines = coalesce(d->'lines', lines), updated_at = now() where wh_pick_lists.id = (d->>'id')::uuid;
    return '{}';

  elsif op = 'po_save' then
    perform wh__require_manager(u);
    insert into wh_pos (id, supplier, lines, note, status, created_by)
      values ((d->>'id')::uuid, coalesce(d->>'supplier',''), coalesce(d->'lines','[]'), coalesce(d->>'note',''), coalesce(d->>'status','open'), u)
      on conflict (id) do update set supplier = excluded.supplier, lines = excluded.lines, note = excluded.note,
        status = excluded.status, updated_at = now()
      returning to_jsonb(wh_pos.*) into r;
    perform wh__log(u, 'po_save', 'PO ' || (r->>'number'), '{}');
    return jsonb_build_object('number', r->>'number');

  elsif op = 'count_save' then
    select * into cnt from wh_counts where wh_counts.id = (d->>'id')::uuid;
    if cnt.id is null or (d ? 'assigned_to') or (d ? 'name') then
      perform wh__require_manager(u);
    elsif u <> coalesce(cnt.assigned_to, -1) then
      perform wh__require_manager(u);
    end if;
    insert into wh_counts (id, name, location_ids, assigned_to, lines, status, created_by)
      values ((d->>'id')::uuid, coalesce(d->>'name','Count'), coalesce(d->'location_ids','[]'), nullif(d->>'assigned_to','')::bigint,
              coalesce(d->'lines','[]'), coalesce(d->>'status','open'), u)
      on conflict (id) do update set
        name = coalesce(d->>'name', wh_counts.name),
        location_ids = coalesce(d->'location_ids', wh_counts.location_ids),
        assigned_to = case when d ? 'assigned_to' then nullif(d->>'assigned_to','')::bigint else wh_counts.assigned_to end,
        lines = coalesce(d->'lines', wh_counts.lines),
        status = coalesce(d->>'status', wh_counts.status), updated_at = now();
    perform wh__log(u, 'count_save', coalesce(d->>'name', cnt.name), jsonb_build_object('status', d->>'status'));
    return '{}';

  elsif op = 'report_save' then
    insert into wh_saved_reports (id, name, kind, filters, created_by)
      values ((d->>'id')::uuid, d->>'name', d->>'kind', coalesce(d->'filters','{}'), u)
      on conflict (id) do update set name = excluded.name, kind = excluded.kind, filters = excluded.filters, updated_at = now();
    return '{}';
  elsif op = 'report_delete' then
    delete from wh_saved_reports where wh_saved_reports.id = (d->>'id')::uuid;
    return '{}';

  elsif op = 'setting_save' then
    perform wh__require_manager(u);
    if d->>'key' not in ('overdue_days','idle_minutes','correction_days') then raise exception 'wh: setting not editable here'; end if;
    insert into wh_settings (key, value) values (d->>'key', d->'value')
      on conflict (key) do update set value = excluded.value, updated_at = now();
    perform wh__log(u, 'setting_save', d->>'key', jsonb_build_object('value', d->'value'));
    return '{}';
  end if;

  raise exception 'wh: unknown operation %', op;
end $$;

-- ---------------------------------------------------------------- functions the app calls

create or replace function wh_submit(p_key text, p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p jsonb; res jsonb; out jsonb := '[]'; done jsonb;
begin
  perform wh__require_key(p_key);
  for p in select * from jsonb_array_elements(p_ops) loop
    select result into done from wh_ops where client_id = (p->>'client_id')::uuid;
    if found then
      out := out || jsonb_build_array(jsonb_build_object('client_id', p->>'client_id', 'dup', true) || coalesce(done,'{}'));
      continue;
    end if;
    begin
      res := jsonb_build_object('ok', true) || wh__apply_op(p);
    exception when others then
      res := jsonb_build_object('ok', false, 'error', regexp_replace(sqlerrm, '^wh: ', ''));
    end;
    insert into wh_ops (client_id, op, user_id, result)
      values ((p->>'client_id')::uuid, p->>'op', nullif(p->>'user_id','')::bigint, res);
    out := out || jsonb_build_array(jsonb_build_object('client_id', p->>'client_id') || res);
  end loop;
  return out;
end $$;

create or replace function wh_jobs(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform wh__require_key(p_key);
  return jsonb_build_object(
    'synced_at', (select max(synced_at) from qbt_jobcode_tree),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_array(jobcode_id, name, full_name, parent_id, has_children) order by full_name), '[]')
             from qbt_jobcode_tree where active and jobcode_type = 'regular'));
end $$;

create or replace function wh_snapshot(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform wh__require_key(p_key);
  return jsonb_build_object(
    'server_time', now(),
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from wh_settings),
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', user_id, 'name', name, 'role', role,
                'salt', pin_salt, 'hash', pin_hash, 'iter', pin_iter) order by name), '[]') from wh__people()),
    'items', (select coalesce(jsonb_agg(to_jsonb(i) order by i.number), '[]') from wh_items i),
    'photos', (select coalesce(jsonb_object_agg(item_id, ids), '{}') from
                (select item_id, jsonb_agg(id order by created_at) ids from wh_item_photos group by item_id) p),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.name), '[]') from wh_locations l),
    'fields', (select coalesce(jsonb_agg(to_jsonb(f) order by f.sort, f.name), '[]') from wh_custom_fields f),
    'checkouts', (select coalesce(jsonb_agg(to_jsonb(c) order by c.opened_at), '[]') from wh_checkouts c where closed_at is null),
    'carts', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', c.id, 'client_id', c.client_id, 'entered_by', c.entered_by, 'on_behalf_of', c.on_behalf_of,
                'received_at', c.received_at, 'client_at', c.client_at, 'note', wh__cart_note(c.id),
                'corrections', (select count(*) from wh_carts k where k.correction_of = c.id),
                'cancelled', exists (select 1 from wh_carts k where k.correction_of = c.id and k.cancelled),
                'lines', (select coalesce(jsonb_agg(to_jsonb(s) order by s.line_no), '[]') from wh__cart_state(c.id) s),
                'equipment', (select coalesce(jsonb_agg(jsonb_build_object('kind', l.kind, 'item_id', l.item_id, 'qty', l.qty,
                   'jobcode_id', l.jobcode_id, 'checkout_id', l.checkout_id) order by l.line_no), '[]')
                   from wh_lines l where l.cart_id = c.id and l.kind in ('checkout','checkin'))
              ) order by c.id desc), '[]')
              from wh_carts c where c.kind = 'cart' and c.received_at > now() - interval '15 days'),
    'returnable', (select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'cart_id', l.cart_id, 'item_id', l.item_id,
                'qty', l.qty, 'jobcode_id', l.jobcode_id, 'user_id', coalesce(c.on_behalf_of, c.entered_by), 'at', c.received_at)), '[]')
              from wh_lines l join wh_carts c on c.id = l.cart_id
              where l.kind = 'take' and c.kind = 'cart' and c.received_at > now() - interval '60 days'),
    'picks', (select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc), '[]') from wh_pick_lists p
              where status = 'open' or updated_at > now() - interval '14 days'),
    'pos', (select coalesce(jsonb_agg(to_jsonb(p) order by p.number desc), '[]') from wh_pos p
            where status in ('open','partial') or updated_at > now() - interval '60 days'),
    'counts', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]') from wh_counts c
               where status in ('open','submitted') or updated_at > now() - interval '30 days'),
    'reports', (select coalesce(jsonb_agg(to_jsonb(r) order by r.name), '[]') from wh_saved_reports r),
    'delivery', jsonb_build_object(
       'waiting', (select count(*) from wh_docs where revision > delivered_revision),
       'oldest_waiting', (select min(last_edit_at) from wh_docs where revision > delivered_revision),
       'last_delivered', (select max(delivered_at) from wh_docs),
       'last_error', (select last_error from wh_docs where last_error is not null order by last_edit_at desc limit 1))
  );
end $$;

create or replace function wh_photos(p_key text, p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform wh__require_key(p_key);
  return (select coalesce(jsonb_object_agg(id, data), '{}') from wh_item_photos where id = any(p_ids));
end $$;

-- Report data for a date range: ledger rows, activity, and Carts with their lines.
create or replace function wh_query(p_key text, p_kind text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform wh__require_key(p_key);
  if p_kind = 'ledger' then
    return (select coalesce(jsonb_agg(to_jsonb(l) order by l.at), '[]') from wh_ledger l where at >= p_from and at < p_to);
  elsif p_kind = 'activity' then
    return (select coalesce(jsonb_agg(to_jsonb(a) order by a.at), '[]') from wh_activity a where at >= p_from and at < p_to);
  elsif p_kind = 'carts' then
    return (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('lines',
              (select coalesce(jsonb_agg(to_jsonb(l) order by l.line_no), '[]') from wh_lines l where l.cart_id = c.id))
            order by c.id), '[]')
            from wh_carts c where received_at >= p_from and received_at < p_to);
  end if;
  raise exception 'wh: unknown report data %', p_kind;
end $$;

-- ---------------------------------------------------------------- Drive delivery (Apps Script)

create or replace function wh__doc_payload(p_doc bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d wh_docs; c wh_carts; k wh_carts; j record; tz text; prev jsonb; nxt jsonb; prev_note text;
  sections jsonb := '[]'; orig jsonb; cur jsonb; leaf text; fname text;
begin
  select * into d from wh_docs where id = p_doc;
  select * into c from wh_carts where id = d.cart_id;
  select name, full_name into j from qbt_jobcode_tree where jobcode_id = d.jobcode_id;
  tz := coalesce(wh__setting('timezone')#>>'{}', 'UTC');

  select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'kind', l.kind, 'qty', l.qty,
           'jobcode_id', l.jobcode_id, 'note', l.note) order by l.line_no), '[]')
    into prev from wh_lines l where l.cart_id = c.id and l.kind in ('take','return');
  prev_note := c.note;

  -- Original items for this Job code.
  select coalesce(jsonb_agg(jsonb_build_object('number', i.number, 'name', i.name, 'qty', l.qty, 'note', l.note)
           order by l.line_no), '[]')
    into orig from wh_lines l join wh_items i on i.id = l.item_id
    where l.cart_id = c.id and l.kind = 'take' and l.jobcode_id = d.jobcode_id;

  -- One section per Correction that changed this Job code, newest first.
  for k in select * from wh_carts where correction_of = c.id order by correction_seq loop
    select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'kind', l.kind, 'qty', l.qty,
             'jobcode_id', l.jobcode_id, 'note', l.note) order by l.line_no), '[]')
      into nxt from wh_lines l where l.cart_id = k.id;
    if k.cancelled or wh__job_sig(prev, d.jobcode_id) <> wh__job_sig(nxt, d.jobcode_id) or coalesce(prev_note,'') <> coalesce(k.note,'') then
      sections := jsonb_build_array(jsonb_build_object(
        'seq', k.correction_seq,
        'at', to_char(k.received_at at time zone tz, 'YYYY-MM-DD HH24:MI'),
        'by', wh__name(k.entered_by),
        'correction_note', k.correction_note,
        'cancelled', k.cancelled,
        'note_before', prev_note, 'note_after', k.note,
        'changes', (
          select coalesce(jsonb_agg(jsonb_build_object('number', i.number, 'name', i.name, 'before', b, 'after', a,
                   'note', n) order by i.number), '[]')
          from (
            select item_id, sum(b) b, sum(a) a, string_agg(distinct nullif(note,''), '; ') n from (
              select (e->>'item_id')::uuid item_id, (e->>'qty')::numeric b, 0::numeric a, e->>'note' note
                from jsonb_array_elements(prev) e where e->>'kind' = 'take' and (e->>'jobcode_id')::bigint = d.jobcode_id
              union all
              select (e->>'item_id')::uuid, 0, (e->>'qty')::numeric, e->>'note'
                from jsonb_array_elements(nxt) e where e->>'kind' = 'take' and (e->>'jobcode_id')::bigint = d.jobcode_id) t
            group by item_id) s join wh_items i on i.id = s.item_id
          where s.b <> s.a or k.cancelled)
      )) || sections;
    end if;
    prev := nxt; prev_note := k.note;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('number', i.number, 'name', i.name, 'qty', s.qty, 'note', s.note)
           order by s.line_no), '[]')
    into cur from wh__cart_state(c.id) s join wh_items i on i.id = s.item_id
    where s.kind = 'take' and s.jobcode_id = d.jobcode_id;

  leaf := regexp_replace(coalesce(j.name, 'Job ' || d.jobcode_id), '[\\/:*?"<>|]+', '-', 'g');
  fname := leaf || '_' || c.id || '_' || d.vtype || d.vno || '_' || to_char(d.last_edit_at at time zone tz, 'YYMMDD') || '_D' || d.id;

  return jsonb_build_object(
    'doc_id', d.id, 'revision', d.revision, 'file_name', fname, 'old_file_id', d.drive_file_id,
    'version', d.vtype || d.vno, 'cancelled', d.cancelled,
    'branch', coalesce(wh__setting('branch')->>'name', c.branch),
    'job', jsonb_build_object('id', d.jobcode_id, 'name', j.name, 'full_name', j.full_name),
    'cart', jsonb_build_object('id', c.id, 'at', to_char(c.received_at at time zone tz, 'YYYY-MM-DD HH24:MI'),
      'entered_by', wh__name(c.entered_by), 'on_behalf_of', wh__name(c.on_behalf_of), 'note', c.note),
    'current_note', wh__cart_note(c.id),
    'current', cur, 'corrections', sections, 'original', orig,
    'generated_at', to_char(now() at time zone tz, 'YYYY-MM-DD HH24:MI'), 'timezone', tz);
end $$;

create or replace function wh_delivery_claim(p_token text, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not wh__secret_ok('wh_delivery_token', p_token) then raise exception 'wh: delivery token not accepted' using errcode = '28000'; end if;
  return (select coalesce(jsonb_agg(wh__doc_payload(id) order by id), '[]') from
            (select id from wh_docs where revision > delivered_revision order by id limit greatest(1, least(p_limit, 50))) t);
end $$;

create or replace function wh_delivery_confirm(p_token text, p_doc bigint, p_revision int, p_file_id text,
  p_file_name text, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not wh__secret_ok('wh_delivery_token', p_token) then raise exception 'wh: delivery token not accepted' using errcode = '28000'; end if;
  if p_error is not null then
    update wh_docs set last_error = left(p_error, 500) where id = p_doc;
  else
    update wh_docs set delivered_revision = greatest(delivered_revision, p_revision), drive_file_id = p_file_id,
      file_name = p_file_name, delivered_at = now(), last_error = null
    where id = p_doc;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- access

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'wh\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('wh_submit','wh_jobs','wh_snapshot','wh_photos','wh_query','wh_delivery_claim','wh_delivery_confirm') then
      execute format('grant execute on function %s to anon', f.sig);
    end if;
  end loop;
end $$;
