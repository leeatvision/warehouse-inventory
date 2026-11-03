-- Billing document names with spaces, so more of the name shows on Drive's tiles:
-- <Job code> MM/DD/YYYY <Take out | Correction n> by <person>. Only wh_ objects change.

create or replace function wh__doc_payload(p_doc bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d wh_docs; c wh_carts; k wh_carts; j record; tz text; prev jsonb; nxt jsonb; prev_note text;
  sections jsonb := '[]'; orig jsonb; cur jsonb; leaf text; fname text; vlabel text; vby bigint;
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
        'at', to_char(k.received_at at time zone tz, 'MM/DD/YYYY FMHH12:MI AM'),
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

  -- File name: <Job code> MM/DD/YYYY <what> by <who>, e.g. "Main St Remodel 11/03/2026 Take out by Sam Worker".
  -- The date is the last change; "who" is who made that version (for a Take out, the person it was for).
  if d.vtype = 'C' then
    select k2.entered_by into vby from wh_carts k2 where k2.correction_of = c.id order by k2.correction_seq desc limit 1;
    vlabel := case when d.cancelled then 'Cancelled' else 'Correction ' || d.vno end;
  else
    vby := coalesce(c.on_behalf_of, c.entered_by); vlabel := 'Take out';
  end if;
  leaf := regexp_replace(coalesce(j.name, 'Job ' || d.jobcode_id), '[\\/:*?"<>|]+', '-', 'g');
  fname := leaf || ' ' || to_char(d.last_edit_at at time zone tz, 'MM/DD/YYYY') || ' ' || vlabel || ' by '
    || regexp_replace(coalesce(wh__name(vby), 'unknown'), '[\\/:*?"<>|]+', '-', 'g');
  -- Two documents could end up with the same name (same job, day and person): add the Cart number to tell them apart.
  if exists (select 1 from wh_docs o where o.id <> d.id and o.file_name = fname || '.pdf') then fname := fname || ' (Cart ' || c.id || ')'; end if;

  return jsonb_build_object(
    'doc_id', d.id, 'revision', d.revision, 'file_name', fname, 'old_file_id', d.drive_file_id,
    'version', d.vtype || d.vno, 'cancelled', d.cancelled,
    'branch', coalesce(wh__setting('branch')->>'name', c.branch),
    'job', jsonb_build_object('id', d.jobcode_id, 'name', j.name, 'full_name', j.full_name,
      'customer', nullif(regexp_replace(coalesce(j.full_name, ''), '\s*=>\s*[^=]*$', ''), coalesce(j.full_name, '')),
      'address', wh__job_address(j.full_name)),
    'branch_code', c.branch,
    'cart', jsonb_build_object('id', c.id, 'at', to_char(c.received_at at time zone tz, 'MM/DD/YYYY FMHH12:MI AM'),
      'entered_by', wh__name(c.entered_by), 'on_behalf_of', wh__name(c.on_behalf_of), 'note', c.note),
    'current_note', wh__cart_note(c.id),
    'current', cur, 'corrections', sections, 'original', orig,
    'generated_at', to_char(now() at time zone tz, 'MM/DD/YYYY FMHH12:MI AM'), 'timezone', tz);
end $$;

revoke all on function wh__doc_payload(bigint) from public, anon, authenticated;
