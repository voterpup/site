create or replace function vp_recent_pups(p_n int default 30) returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(r order by r.created desc), '[]'::json) from (
    select l.name, l.created_at created,
      coalesce((select src from events c where c.tail = l.tail and c.event = 'pup_created' order by ts limit 1), (select src from events c where c.tail = l.tail order by ts limit 1)) src,
      (select count(*) from entries x where x.tail = l.tail) issues, (select left(body, 50) from entries x where x.tail = l.tail order by created_at limit 1) first,
      exists (select 1 from push_subs p where p.tail = l.tail) push, exists (select 1 from mail_subs m where m.tail = l.tail and m.unsub_at is null) mail,
      (select count(distinct (ts at time zone 'America/Vancouver')::date) from events c where c.tail = l.tail) days_active
    from ledgers l
    where not exists (select 1 from events x join internal_devs i on i.dev = x.dev where x.tail = l.tail)
    order by l.created_at desc limit p_n) r;
$$;
revoke all on function vp_recent_pups(int) from public, anon, authenticated;
create or replace function vp_metrics(p_days int default 14)
returns json language sql security definer set search_path = public as $$
  with days as (select generate_series((now() at time zone 'America/Vancouver')::date - (p_days - 1), (now() at time zone 'America/Vancouver')::date, '1 day')::date d),
  e as (select *, (ts at time zone 'America/Vancouver')::date d from counted_events where ts > now() - (p_days + 8) * interval '1 day'),
  created as (select dev, min(d) d, min(src) src from e where event = 'pup_created' group by dev),
  opens as (select distinct dev, d from e where event = 'open')
  select json_agg(json_build_object(
    'day', days.d,
    'opens', (select count(distinct dev) from e where e.d = days.d and event = 'open'),
    'pups', (select count(*) from e where e.d = days.d and event = 'pup_created'),
    'pups_booth', (select count(*) from e where e.d = days.d and event = 'pup_created' and src in ('booth','demo')),
    'issues', (select count(*) from e where e.d = days.d and event = 'issue'),
    'shared', (select count(*) from e where e.d = days.d and event = 'issue' and (meta->>'shared')::boolean),
    'snaps', (select count(*) from e where e.d = days.d and event = 'snap'),
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
