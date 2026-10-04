-- Auto-onboarding: cities people look at get searched for open 3-1-1 data; a source is switched on only after its
-- recent reports are checked to really sit inside that city's boundary.
create table if not exists city_sources (
  city text primary key, place text, kind text not null default 'socrata', url text, type_col text, ts_col text,
  lat_col text, lng_col text, point_col text, area_col text, status text not null default 'pending',
  note text, inside numeric, checked_at timestamptz not null default now(), added_at timestamptz);
alter table city_sources enable row level security;
alter table city_wanted add column if not exists place text;
alter table city_wanted add column if not exists tried_at timestamptz;

create or replace function vp_city_wanted(p_place text) returns void language plpgsql security definer set search_path = public as $$
declare c text := lower(trim(split_part(coalesce(p_place, ''), ',', 1)));
begin
  if c = '' or length(c) > 60 then return; end if;
  if exists (select 1 from city_reports where city = c and day >= current_date - 7) then return; end if;
  perform vp_limit('city_wanted', vp_conn(), 30, interval '1 day', 'slow down');
  insert into city_wanted(city, asks, place) values (c, 1, nullif(left(p_place, 160), ''))
    on conflict (city) do update set asks = city_wanted.asks + 1, last_ask = now(),
      place = coalesce(nullif(case when position(',' in excluded.place) > 0 then excluded.place end, ''), city_wanted.place);
end $$;
revoke all on function vp_city_wanted(text) from public; grant execute on function vp_city_wanted(text) to anon;

select cron.unschedule('discover-311-hourly') where exists (select 1 from cron.job where jobname = 'discover-311-hourly');
select cron.schedule('discover-311-hourly', '25 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/discover-311',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 120000) $$);
