-- Returns: each person's 14 most recent Take outs on the device, and a search of everything they ever took out.
-- Only wh_ objects change; qbt_jobcode_tree is only read.

-- Every Take out line as it stands now: the latest Correction of each Cart, leaving out cancelled Carts.
create or replace function wh__takeouts(p_user bigint default null, p_since timestamptz default null)
returns table (line_id bigint, cart_id bigint, item_id uuid, qty numeric, jobcode_id bigint, note text, user_id bigint, at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.id, c.id, l.item_id, l.qty, l.jobcode_id, l.note, coalesce(c.on_behalf_of, c.entered_by), c.received_at
  from wh_carts c
  cross join lateral (
    select coalesce((select k.id from wh_carts k where k.correction_of = c.id order by k.correction_seq desc limit 1), c.id) as cid,
           exists (select 1 from wh_carts k where k.correction_of = c.id and k.cancelled) as cancelled) v
  join wh_lines l on l.cart_id = v.cid and l.kind = 'take'
  where c.kind = 'cart' and not v.cancelled
    and (p_user is null or coalesce(c.on_behalf_of, c.entered_by) = p_user)
    and (p_since is null or c.received_at >= p_since)
$$;

-- Search one person's past Take outs by item name or number, Job code, Cart number or note. Every word must match.
create or replace function wh_takeout_search(p_key text, p_user bigint, p_q text, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare words text[];
begin
  perform wh__require_key(p_key);
  words := array_remove(regexp_split_to_array(lower(trim(coalesce(p_q, ''))), '\s+'), '');
  return (select coalesce(jsonb_agg(jsonb_build_object('line_id', s.line_id, 'cart_id', s.cart_id, 'item_id', s.item_id, 'qty', s.qty,
            'jobcode_id', s.jobcode_id, 'note', s.note, 'user_id', s.user_id, 'at', s.at) order by s.at desc, s.line_id desc), '[]')
    from (
      select t.* from wh__takeouts(p_user, null) t
        join wh_items i on i.id = t.item_id
        left join qbt_jobcode_tree j on j.jobcode_id = t.jobcode_id
      where not exists (select 1 from unnest(words) w
                        where position(w in lower(concat_ws(' ', i.name, i.number, replace(j.full_name, '=>', ' '), t.cart_id::text, t.note))) = 0)
      order by t.at desc, t.line_id desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)) s);
end $$;

create index if not exists wh_carts_person on wh_carts (coalesce(on_behalf_of, entered_by), received_at desc) where kind = 'cart';

-- wh_snapshot: 'returnable' becomes each person's 14 most recent Take out lines (from the last year).
do $$
declare def text; old text;
begin
  def := pg_get_functiondef('wh_snapshot(text)'::regprocedure);
  old := $r$'returnable', (select coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'cart_id', l.cart_id, 'item_id', l.item_id,
                'qty', l.qty, 'jobcode_id', l.jobcode_id, 'user_id', coalesce(c.on_behalf_of, c.entered_by), 'at', c.received_at)), '[]')
              from wh_lines l join wh_carts c on c.id = l.cart_id
              where l.kind = 'take' and c.kind = 'cart' and c.received_at > now() - interval '60 days'),$r$;
  if position('wh__takeouts' in def) = 0 then
    if position(old in def) = 0 then raise exception 'wh: returnable block not found in wh_snapshot'; end if;
    def := replace(def, old, $r$'returnable', (select coalesce(jsonb_agg(jsonb_build_object('line_id', r.line_id, 'cart_id', r.cart_id, 'item_id', r.item_id,
                'qty', r.qty, 'jobcode_id', r.jobcode_id, 'note', r.note, 'user_id', r.user_id, 'at', r.at) order by r.at desc, r.line_id desc), '[]')
              from (select t.*, row_number() over (partition by t.user_id order by t.at desc, t.line_id desc) rn
                    from wh__takeouts(null, now() - interval '365 days') t) r where r.rn <= 14),$r$);
    execute def;
  end if;
end $$;

revoke all on function wh__takeouts(bigint, timestamptz) from public, anon, authenticated;
revoke all on function wh_takeout_search(text, bigint, text, int) from public, anon, authenticated;
grant execute on function wh_takeout_search(text, bigint, text, int) to anon;
