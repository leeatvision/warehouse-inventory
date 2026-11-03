-- Cancelled Carts never go to billing as PDFs.
-- A cancelled document that never had a PDF is simply marked done. One whose earlier PDF is already in the
-- billing folder is still handed to the script, which moves that PDF to Trash and makes no new one.
create or replace function wh_delivery_claim(p_token text, p_limit int default 20) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not wh__secret_ok('wh_delivery_token', p_token) then raise exception 'wh: delivery token not accepted' using errcode = '28000'; end if;
  update wh_docs set delivered_revision = revision, last_error = null
    where cancelled and drive_file_id is null and revision > delivered_revision;
  return (select coalesce(jsonb_agg(wh__doc_payload(id) order by id), '[]') from
            (select id from wh_docs where revision > delivered_revision order by id limit greatest(1, least(p_limit, 50))) t);
end $$;

revoke all on function wh_delivery_claim(text, int) from public, anon, authenticated;
grant execute on function wh_delivery_claim(text, int) to anon;

-- Mark the never-delivered cancelled documents done now, so they stop showing as waiting.
update wh_docs set delivered_revision = revision, last_error = null
  where cancelled and drive_file_id is null and revision > delivered_revision;
