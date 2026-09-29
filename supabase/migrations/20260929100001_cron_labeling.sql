create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('label-topics-every-30min') where exists
  (select 1 from cron.job where jobname = 'label-topics-every-30min');
select cron.schedule(
  'label-topics-every-30min',
  '*/30 * * * *',
  $$ select net.http_post(
       url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/label-topics',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
