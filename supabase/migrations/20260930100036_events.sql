-- Measurement: anonymous product events. No names, no emails, no coordinates; a random device id so
-- returns can be counted. Feeds the daily numbers (pups, reminders on, installs, day-1/day-7 return).
create table if not exists events (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  dev    text not null,            -- random id the browser made (vp.dev)
  tail   text,                     -- the pup, when there is one
  event  text not null,
  src    text,                     -- booth / video / sticker / invite / direct
  meta   jsonb not null default '{}'
);
create index if not exists events_ts_idx on events(ts);
create index if not exists events_dev_idx on events(dev, ts);
alter table events enable row level security;
grant all on events to service_role;

create or replace function vp_track(p_dev text, p_event text, p_tail text default null, p_src text default null, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_dev !~ '^[a-z0-9]{8,32}$' then return; end if;
  if p_event not in ('open','pup_created','issue','reminder_on','reminder_off','install','standalone_open','notif_open','swipe','fetch','share_code','pack','map','flashback','tour_done','report_seen','report_skip') then return; end if;
  if (select count(*) from events where dev = p_dev and ts > now() - interval '1 day') >= 300 then return; end if;
  insert into events(dev, tail, event, src, meta)
    values (p_dev, left(p_tail, 60), p_event, left(regexp_replace(coalesce(p_src,''), '[^a-z0-9_-]', '', 'g'), 20), coalesce(p_meta, '{}'::jsonb));
end $$;
revoke all on function vp_track(text, text, text, text, jsonb) from public;
grant execute on function vp_track(text, text, text, text, jsonb) to anon;

-- The daily numbers. d1/d7 = share of devices that created a pup that day and opened the app again 1 / 7 days later.
create or replace function vp_metrics(p_days int default 14)
returns json language sql security definer set search_path = public as $$
  with days as (select generate_series(current_date - (p_days - 1), current_date, '1 day')::date d),
  e as (select *, (ts at time zone 'America/Vancouver')::date d from events where ts > now() - (p_days + 8) * interval '1 day'),
  created as (select dev, min(d) d, min(src) src from e where event = 'pup_created' group by dev),
  opens as (select distinct dev, d from e where event = 'open')
  select json_agg(json_build_object(
    'day', days.d,
    'opens', (select count(distinct dev) from e where e.d = days.d and event = 'open'),
    'pups', (select count(*) from e where e.d = days.d and event = 'pup_created'),
    'pups_booth', (select count(*) from e where e.d = days.d and event = 'pup_created' and src = 'booth'),
    'issues', (select count(*) from e where e.d = days.d and event = 'issue'),
    'shared', (select count(*) from e where e.d = days.d and event = 'issue' and (meta->>'shared')::boolean),
    'reminders_on', (select count(distinct dev) from e where e.d = days.d and event = 'reminder_on'),
    'installs', (select count(distinct dev) from e where e.d = days.d and event in ('install','standalone_open')),
    'notif_opens', (select count(*) from e where e.d = days.d and event = 'notif_open'),
    'swipes', (select count(*) from e where e.d = days.d and event = 'swipe'),
    'backs', (select count(*) from backs where (created_at at time zone 'America/Vancouver')::date = days.d),
    'd1', (select round(100.0 * count(*) filter (where exists (select 1 from opens o where o.dev = c.dev and o.d = c.d + 1)) / nullif(count(*), 0)) from created c where c.d = days.d),
    'd7', (select round(100.0 * count(*) filter (where exists (select 1 from opens o where o.dev = c.dev and o.d between c.d + 5 and c.d + 9)) / nullif(count(*), 0)) from created c where c.d = days.d),
    'd1_rem', (select round(100.0 * count(*) filter (where exists (select 1 from opens o where o.dev = c.dev and o.d = c.d + 1)) / nullif(count(*), 0))
               from created c where c.d = days.d and exists (select 1 from e r where r.dev = c.dev and r.event = 'reminder_on')),
    'd1_norem', (select round(100.0 * count(*) filter (where exists (select 1 from opens o where o.dev = c.dev and o.d = c.d + 1)) / nullif(count(*), 0))
               from created c where c.d = days.d and not exists (select 1 from e r where r.dev = c.dev and r.event = 'reminder_on'))
  ) order by days.d desc) from days;
$$;
revoke all on function vp_metrics(int) from public, anon, authenticated;
grant execute on function vp_metrics(int) to service_role;
