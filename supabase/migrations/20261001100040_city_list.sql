-- cities that have 3-1-1 data, with a centre point, so "Everywhere" can list them by distance
create or replace function vp_city_pulse_list()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('city', c.city, 'week_total', c.n, 'lat', p.lat, 'lng', p.lng) order by c.n desc), '[]'::json)
  from (select city, sum(n) n from city_reports where day >= current_date - 6 group by city) c
  left join (select city, avg(lat) lat, avg(lng) lng from city_pins group by city) p on p.city = c.city;
$$;
grant execute on function vp_city_pulse_list() to anon;
