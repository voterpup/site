-- "You're not alone": similar shared issues near a new one; and the pup's 7 pm report facts (new agreement, a good thing nearby).
create extension if not exists pg_trgm with schema extensions;
create or replace function vp_similar(p_place text, p_body text, p_tail text default null)
returns json language sql security definer set search_path = public, extensions as $$
  with c as (select lower(trim(split_part(coalesce(p_place,''), ',', 1))) city)
  select coalesce(json_agg(json_build_object('id', id, 'body', body, 'topic', topic, 'backs', backs, 'sim', round(sim::numeric, 2)) order by sim desc), '[]'::json)
  from (
    select e.id, e.body, e.topic, (select count(*) from backs b where b.entry_id = e.id) backs,
           similarity(lower(e.body), lower(coalesce(p_body, ''))) sim
    from entries e, c
    where e.shared and e.body is not null and lower(trim(split_part(coalesce(e.place,''), ',', 1))) = c.city
      and e.created_at > now() - interval '120 days' and (p_tail is null or e.tail <> p_tail)
    order by sim desc limit 3
  ) q where sim >= 0.18;
$$;
grant execute on function vp_similar(text, text, text) to anon;

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
  best as (select * from ranked where rk is not null order by rk asc limit 1),
  nb as (select m.body, count(*) n from backs b join mine m on m.id = b.entry_id where b.created_at > now() - interval '26 hours' group by m.id, m.body order by n desc, max(b.created_at) desc limit 1),
  good as (select e.body from entries e, c where e.shared and e.tail <> p_tail and 'good' = any(e.tags) and e.created_at > now() - interval '48 hours'
           and lower(trim(split_part(coalesce(e.place,''), ',', 1))) = c.city order by e.created_at desc limit 1)
  select json_build_object('entries', (select count(*) from mine),
                           'backs', (select count(*) from backs b join mine m on m.id = b.entry_id),
                           'city', split_part((select place from place), ',', 1),
                           'stats', (select st from s),
                           'today', json_build_object('issues', (select count(*) from tod), 'pups', (select count(distinct tail) from tod), 'top_topic', (select topic from tt)),
                           'city_reports', json_build_object('n', (select n from cr), 'top_topic', (select topic from crt)),
                           'new_backs', (select json_build_object('n', n, 'body', body) from nb),
                           'good_nearby', (select body from good),
                           'top', (select json_build_object('body', body, 'rank', rk, 'city', city) from best));
$$;
