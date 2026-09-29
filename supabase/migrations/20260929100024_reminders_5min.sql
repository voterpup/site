-- Reminders land within 5 minutes of the chosen time (was 15).
create or replace function vp_due_reminders()
returns table(endpoint text, p256dh text, auth text, tail text, name text)
language sql security definer set search_path = public as $$
  select s.endpoint, s.p256dh, s.auth, s.tail, l.name
  from push_subs s join ledgers l on l.tail = s.tail,
       lateral (select (now() at time zone s.tz) as lt) t
  where ((extract(hour from t.lt) * 60 + extract(minute from t.lt)) - (s.hour * 60 + s.minute) + 1440)::int % 1440 < 5
    and (s.last_sent is null or s.last_sent < now() - case s.freq when 'daily' then interval '20 hours'
                                                                  when '2days' then interval '44 hours'
                                                                  else interval '164 hours' end);
$$;
select cron.unschedule('send-reminders-15min') where exists (select 1 from cron.job where jobname = 'send-reminders-15min');
select cron.unschedule('send-reminders-5min') where exists (select 1 from cron.job where jobname = 'send-reminders-5min');
select cron.schedule('send-reminders-5min', '*/5 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/send-reminders',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$);
