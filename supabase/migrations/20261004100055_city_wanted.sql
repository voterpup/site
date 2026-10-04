-- Cities people look at that have no official 3-1-1 data in VoterPup yet: the to-do list for adding sources.
create table if not exists city_wanted (city text primary key, asks int not null default 0, last_ask timestamptz not null default now());
alter table city_wanted enable row level security;
create or replace function vp_city_wanted(p_place text) returns void language plpgsql security definer set search_path = public as $$
declare c text := lower(trim(split_part(coalesce(p_place, ''), ',', 1)));
begin
  if c = '' or length(c) > 60 then return; end if;
  if exists (select 1 from city_reports where city = c and day >= current_date - 7) then return; end if;
  perform vp_limit('city_wanted', vp_conn(), 30, interval '1 day', 'slow down');
  insert into city_wanted(city, asks) values (c, 1) on conflict (city) do update set asks = city_wanted.asks + 1, last_ask = now();
end $$;
revoke all on function vp_city_wanted(text) from public; grant execute on function vp_city_wanted(text) to anon;
