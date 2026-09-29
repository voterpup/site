-- Reminders ("anything to tell your pup?"): one row per device push subscription, with the person's
-- own schedule in their own time zone. Default: daily at 21:00 local.
create table if not exists push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  tail       text not null references ledgers(tail) on delete cascade,
  tz         text not null default 'UTC',
  freq       text not null default 'daily' check (freq in ('daily','2days','weekly')),
  hour       int  not null default 21 check (hour between 0 and 23),
  minute     int  not null default 0  check (minute between 0 and 59),
  last_sent  timestamptz,
  fails      int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_tail_idx on push_subs(tail);
alter table push_subs enable row level security;
grant all on push_subs to service_role;

create or replace function vp_set_reminder(p_tail text, p_endpoint text, p_p256dh text, p_auth text,
                                           p_tz text, p_freq text, p_hour int, p_minute int)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if coalesce(p_endpoint,'') !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad subscription'; end if;
  if length(coalesce(p_p256dh,'')) not between 40 and 200 or length(coalesce(p_auth,'')) not between 10 and 100 then raise exception 'bad keys'; end if;
  if p_freq not in ('daily','2days','weekly') then raise exception 'bad frequency'; end if;
  if p_hour not between 0 and 23 or p_minute not between 0 and 59 then raise exception 'bad time'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then p_tz := 'UTC'; end if;
  insert into push_subs(endpoint, p256dh, auth, tail, tz, freq, hour, minute)
    values (p_endpoint, p_p256dh, p_auth, p_tail, p_tz, p_freq, p_hour, p_minute)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, tail = excluded.tail,
    tz = excluded.tz, freq = excluded.freq, hour = excluded.hour, minute = excluded.minute, fails = 0;
  return json_build_object('ok', true);
end $$;
revoke all on function vp_set_reminder(text,text,text,text,text,text,int,int) from public;
grant execute on function vp_set_reminder(text,text,text,text,text,text,int,int) to anon;

-- turning reminders off needs the endpoint, which only that device's browser knows
create or replace function vp_reminder_off(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_subs where endpoint = p_endpoint;
$$;
revoke all on function vp_reminder_off(text) from public;
grant execute on function vp_reminder_off(text) to anon;

-- who is due right now (their local clock is inside the last 15 minutes of their chosen time)
create or replace function vp_due_reminders()
returns table(endpoint text, p256dh text, auth text, tail text, name text)
language sql security definer set search_path = public as $$
  select s.endpoint, s.p256dh, s.auth, s.tail, l.name
  from push_subs s join ledgers l on l.tail = s.tail,
       lateral (select (now() at time zone s.tz) as lt) t
  where ((extract(hour from t.lt) * 60 + extract(minute from t.lt)) - (s.hour * 60 + s.minute) + 1440)::int % 1440 < 15
    and (s.last_sent is null or s.last_sent < now() - case s.freq when 'daily' then interval '20 hours'
                                                                  when '2days' then interval '44 hours'
                                                                  else interval '164 hours' end);
$$;
revoke all on function vp_due_reminders() from public, anon, authenticated;
grant execute on function vp_due_reminders() to service_role;

select cron.unschedule('send-reminders-15min') where exists (select 1 from cron.job where jobname = 'send-reminders-15min');
select cron.schedule('send-reminders-15min', '*/15 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/send-reminders',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$);
