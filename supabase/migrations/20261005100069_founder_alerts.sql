-- Founder alerts: every Claude call that fails is logged here, and a cron mails the founder every 30 minutes
-- when there are new failures or new pups that came in through an ad link (yt*/ig*). Nothing personal is stored.
create table if not exists svc_errors (id bigserial primary key, ts timestamptz not null default now(), svc text not null, msg text);
create index if not exists svc_errors_ts on svc_errors (ts desc);
create table if not exists alert_state (key text primary key, val text);
alter table svc_errors enable row level security; alter table alert_state enable row level security;
grant select, insert, update, delete on svc_errors, alert_state to service_role; grant usage, select on sequence svc_errors_id_seq to service_role;
select cron.unschedule('founder-alerts-30min') where exists (select 1 from cron.job where jobname = 'founder-alerts-30min');
select cron.schedule('founder-alerts-30min', '*/30 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/founder-alerts',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000) $$);
