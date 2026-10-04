-- Smaller city cards (fewer pins in the list), and pins by map area so the map can show any city it's looking at.
drop function if exists vp_city_pulse(text);
create or replace function vp_city_pulse(p_place text, p_pins int default 400)
returns json language sql stable security definer set search_path = public as $$
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
             from (select * from city_pins p, c where p.city = c.city and p.lat is not null order by ts desc limit least(greatest(coalesce(p_pins, 400), 0), 400)) q),
    'updated', (select max(ts) from city_pins p, c where p.city = c.city));
$$;
grant execute on function vp_city_pulse(text, int) to anon;

create index if not exists city_pins_latlng on city_pins (lat, lng);
create or replace function vp_city_pins_in(p_s double precision, p_w double precision, p_n double precision, p_e double precision, p_limit int default 300)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', id, 'city', city, 'lat', lat, 'lng', lng, 'topic', topic, 'type', rtype, 'area', area, 'ts', ts)), '[]'::json)
  from (select * from city_pins where lat between p_s and p_n and lng between p_w and p_e order by ts desc limit least(greatest(coalesce(p_limit, 300), 1), 500)) q;
$$;
grant execute on function vp_city_pins_in(double precision, double precision, double precision, double precision, int) to anon;
