-- My spot: reasons to come back, by email. Two kinds: "tell me when someone reads my memory" and "tell me when new memories appear at this shop".
create table if not exists spot_subs (
  id bigserial primary key,
  email text not null,
  uid uuid,
  kind text not null check (kind in ('my_memory', 'place_new')),
  spot_code text not null,              -- the memory (my_memory) or the shop (place_new)
  token text not null unique,
  created_at timestamptz not null default now(),
  last_sent timestamptz,
  unsub_at timestamptz,
  unique (email, kind, spot_code)
);
alter table spot_subs enable row level security;
grant all on table spot_subs to service_role;
grant usage, select, update on sequence spot_subs_id_seq to service_role;
revoke all on table spot_subs from anon, authenticated;
-- daily at 17:10 UTC (morning on the west coast): memory-read mails, new-at-shop mails, and the owners' weekly numbers on Mondays
select cron.schedule('myspot-mail-daily', '10 17 * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/thatspot', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"action":"cron"}'::jsonb) $$);
notify pgrst, 'reload schema';
