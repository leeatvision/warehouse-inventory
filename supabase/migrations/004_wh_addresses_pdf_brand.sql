-- Job site addresses (read from QuickBooks Online customers, matched on the Job code's full name), the address in
-- the Job code list and the billing documents, and the PDF's look (wh_settings 'pdf', set from the private brand repo).
-- Existing tables are only read.

create or replace function wh__job_address(p_full text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('source', src, 'lines', to_jsonb(array_remove(array[l1, l2, nullif(trim(concat_ws(' ', nullif(concat_ws(', ', city, st), ''), zip)), '')], null)))
  from (
    select case when has_ship then 'site' else 'billing' end src,
      nullif(trim(case when has_ship then c.ship_addr_line1 else c.bill_addr_line1 end), '') l1,
      nullif(trim(case when has_ship then c.ship_addr_line2 else c.bill_addr_line2 end), '') l2,
      nullif(trim(case when has_ship then c.ship_addr_city else c.bill_addr_city end), '') city,
      nullif(trim(case when has_ship then c.ship_addr_state else c.bill_addr_state end), '') st,
      nullif(trim(case when has_ship then c.ship_addr_postal_code else c.bill_addr_postal_code end), '') zip
    from (select q.*, coalesce(trim(q.ship_addr_line1), '') <> '' as has_ship from qbo_customers q
          where p_full is not null and lower(q.fully_qualified_name) = lower(replace(p_full, '=>', ':'))
            and (coalesce(trim(q.ship_addr_line1), '') <> '' or coalesce(trim(q.bill_addr_line1), '') <> '')
          order by q.active desc limit 1) c
  ) a
$$;

create or replace function wh_jobs(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform wh__require_key(p_key);
  return jsonb_build_object(
    'synced_at', (select max(synced_at) from qbt_jobcode_tree),
    'jobs', (
      with addr as (
        select distinct on (k) k, concat_ws(', ', l1, nullif(trim(concat_ws(' ', nullif(concat_ws(', ', city, st), ''), zip)), '')) one_line
        from (select lower(fully_qualified_name) k, active,
                case when coalesce(trim(ship_addr_line1), '') <> '' then nullif(trim(ship_addr_line1), '') else nullif(trim(bill_addr_line1), '') end l1,
                nullif(trim(case when coalesce(trim(ship_addr_line1), '') <> '' then ship_addr_city else bill_addr_city end), '') city,
                nullif(trim(case when coalesce(trim(ship_addr_line1), '') <> '' then ship_addr_state else bill_addr_state end), '') st,
                nullif(trim(case when coalesce(trim(ship_addr_line1), '') <> '' then ship_addr_postal_code else bill_addr_postal_code end), '') zip
              from qbo_customers) q
        where l1 is not null order by k, active desc)
      select coalesce(jsonb_agg(jsonb_build_array(t.jobcode_id, t.name, t.full_name, t.parent_id, t.has_children, a.one_line) order by t.full_name), '[]')
      from qbt_jobcode_tree t left join addr a on a.k = lower(replace(t.full_name, '=>', ':'))
      where t.active and t.jobcode_type = 'regular'));
end $$;

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
    'job', jsonb_build_object('id', d.jobcode_id, 'name', j.name, 'full_name', j.full_name,
      'customer', nullif(regexp_replace(coalesce(j.full_name, ''), '\s*=>\s*[^=]*$', ''), coalesce(j.full_name, '')),
      'address', wh__job_address(j.full_name)),
    'branch_code', c.branch,
    'cart', jsonb_build_object('id', c.id, 'at', to_char(c.received_at at time zone tz, 'YYYY-MM-DD HH24:MI'),
      'entered_by', wh__name(c.entered_by), 'on_behalf_of', wh__name(c.on_behalf_of), 'note', c.note),
    'current_note', wh__cart_note(c.id),
    'current', cur, 'corrections', sections, 'original', orig,
    'generated_at', to_char(now() at time zone tz, 'YYYY-MM-DD HH24:MI'), 'timezone', tz);
end $$;


-- The PDF's look for the billing script: called once per run, so the logo is not repeated in every document.
create or replace function wh_delivery_brand(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not wh__secret_ok('wh_delivery_token', p_token) then raise exception 'wh: delivery token not accepted' using errcode = '28000'; end if;
  return coalesce(wh__setting('pdf'), '{}'::jsonb) || jsonb_build_object('branch', wh__setting('branch'), 'timezone', wh__setting('timezone'));
end $$;

insert into wh_settings (key, value) values ('pdf', '{}') on conflict (key) do nothing;

revoke all on function wh__job_address(text) from public, anon, authenticated;
revoke all on function wh__doc_payload(bigint) from public, anon, authenticated;
revoke all on function wh_jobs(text) from public, anon, authenticated;
grant execute on function wh_jobs(text) to anon;
revoke all on function wh_delivery_brand(text) from public, anon, authenticated;
grant execute on function wh_delivery_brand(text) to anon;
