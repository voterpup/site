-- Run AFTER the function is deployed. Requires extensions: pg_cron + pg_net
-- (Dashboard -> Database -> Extensions -> enable both), then paste this.
select cron.schedule(
  'label-topics-every-30min',
  '*/30 * * * *',
  $$ select net.http_post(
       url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/label-topics',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
