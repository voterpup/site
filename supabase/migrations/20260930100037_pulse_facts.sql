-- The 7 pm message is the day's pulse: today's counts for the pup's city (falls back to the week)
create or replace function vp_reminder_facts(p_tail text)
returns json language sql security definer set search_path = public as $$
  with mine as (select * from entries where tail = p_tail),
  place as (select place from mine where place is not null order by created_at desc limit 1),
  c as (select lower(trim(split_part(coalesce((select place from place),''), ',', 1))) city),
  tod as (select * from entries e, c where e.created_at > now() - interval '24 hours' and lower(trim(split_part(coalesce(e.place,''), ',', 1))) = c.city),
  tt as (select topic, count(*) n from tod where topic is not null and topic <> 'other' group by topic order by n desc limit 1),
  s as (select vp_place_stats((select place from place)) st),
  ranked as (select body, vp_weekly_rank(id) rk, split_part(coalesce(place,''), ',', 1) city from mine where shared),
  best as (select * from ranked where rk is not null order by rk asc limit 1)
  select json_build_object('entries', (select count(*) from mine),
                           'backs', (select count(*) from backs b join mine m on m.id = b.entry_id),
                           'city', split_part((select place from place), ',', 1),
                           'stats', (select st from s),
                           'today', json_build_object('issues', (select count(*) from tod), 'pups', (select count(distinct tail) from tod), 'top_topic', (select topic from tt)),
                           'top', (select json_build_object('body', body, 'rank', rk, 'city', city) from best));
$$;
