-- City 3-1-1 reports (official open data), shown beside residents' issues and always labelled as the city's data.
create table if not exists city_reports (
  city   text not null, day date not null, rtype text not null, topic text, n int not null default 0,
  primary key (city, day, rtype)
);
create table if not exists city_pins (
  id text primary key, city text not null, rtype text not null, topic text, lat double precision, lng double precision, area text, ts timestamptz not null
);
create index if not exists city_pins_city_ts on city_pins(city, ts desc);
alter table city_reports enable row level security; alter table city_pins enable row level security;
grant all on city_reports, city_pins to service_role;

create or replace function vp_city_pulse(p_place text)
returns json language sql security definer set search_path = public as $$
  with c as (select lower(trim(split_part(coalesce(p_place,''), ',', 1))) city),
  wk as (select topic, sum(n) n from city_reports, c where city_reports.city = c.city and day >= current_date - 6 group by topic),
  tod as (select coalesce(sum(n), 0) n from city_reports, c where city_reports.city = c.city and day = current_date),
  top as (select topic from wk where topic is not null and topic <> 'other' order by n desc limit 1)
  select json_build_object(
    'city', (select initcap(city) from c),
    'week_total', (select coalesce(sum(n), 0) from wk),
    'today', (select n from tod),
    'top_topic', (select topic from top),
    'by_topic', (select coalesce(json_agg(json_build_object('topic', topic, 'n', n) order by n desc), '[]'::json) from wk where topic is not null),
    'pins', (select coalesce(json_agg(json_build_object('lat', lat, 'lng', lng, 'topic', topic, 'type', rtype, 'area', area, 'ts', ts) order by ts desc), '[]'::json)
             from (select * from city_pins p, c where p.city = c.city and p.lat is not null order by ts desc limit 400) q),
    'updated', (select max(ts) from city_pins p, c where p.city = c.city));
$$;
grant execute on function vp_city_pulse(text) to anon;

-- the 7 pm pulse mentions the city's own reports too
create or replace function vp_reminder_facts(p_tail text)
returns json language sql security definer set search_path = public as $$
  with mine as (select * from entries where tail = p_tail),
  place as (select place from mine where place is not null order by created_at desc limit 1),
  c as (select lower(trim(split_part(coalesce((select place from place),''), ',', 1))) city),
  tod as (select * from entries e, c where e.created_at > now() - interval '24 hours' and lower(trim(split_part(coalesce(e.place,''), ',', 1))) = c.city),
  tt as (select topic, count(*) n from tod where topic is not null and topic <> 'other' group by topic order by n desc limit 1),
  s as (select vp_place_stats((select place from place)) st),
  cr as (select coalesce(sum(n), 0) n from city_reports r, c where r.city = c.city and r.day >= current_date - 1),
  crt as (select topic from city_reports r, c where r.city = c.city and r.day >= current_date - 6 and topic is not null and topic <> 'other' group by topic order by sum(n) desc limit 1),
  ranked as (select body, vp_weekly_rank(id) rk, split_part(coalesce(place,''), ',', 1) city from mine where shared),
  best as (select * from ranked where rk is not null order by rk asc limit 1)
  select json_build_object('entries', (select count(*) from mine),
                           'backs', (select count(*) from backs b join mine m on m.id = b.entry_id),
                           'city', split_part((select place from place), ',', 1),
                           'stats', (select st from s),
                           'today', json_build_object('issues', (select count(*) from tod), 'pups', (select count(distinct tail) from tod), 'top_topic', (select topic from tt)),
                           'city_reports', json_build_object('n', (select n from cr), 'top_topic', (select topic from crt)),
                           'top', (select json_build_object('body', body, 'rank', rk, 'city', city) from best));
$$;

select cron.unschedule('sync-311-6h') where exists (select 1 from cron.job where jobname = 'sync-311-6h');
select cron.schedule('sync-311-6h', '40 */6 * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/sync-311',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$);
