-- Default settings and the two Vault secrets. Company-specific values (Branch, Managers, exclusions)
-- are applied separately from the private brand repo, not from here.
insert into wh_settings (key, value) values
  ('timezone', '"UTC"'), ('idle_minutes', '10'), ('overdue_days', '7'), ('correction_days', '14'),
  ('branch', '{"code": "", "name": ""}')
on conflict (key) do nothing;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'wh_device_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(18), 'hex'), 'wh_device_key', 'Warehouse app: typed into each device once');
  end if;
  if not exists (select 1 from vault.secrets where name = 'wh_delivery_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'wh_delivery_token', 'Warehouse app: Apps Script billing delivery');
  end if;
end $$;
