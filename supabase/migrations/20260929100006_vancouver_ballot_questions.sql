-- Oct 17 2026 Vancouver ballot questions (sources: vancouver.ca, Daily Hive; verified Sep 29 2026)
insert into elections (name, level, region, vote_date, kind, topic)
select v.* from (values
  ('Borrowing Q: $292M bridges, roads & sidewalks (Granville + Cambie bridges)', 'city', 'vancouver', date '2026-10-17', 'decision', 'transit'),
  ('Borrowing Q: community centres, pools, rinks, libraries, childcare',        'city', 'vancouver', date '2026-10-17', 'decision', 'parks'),
  ('Borrowing Q: fire halls, service yards, civic theatres',                     'city', 'vancouver', date '2026-10-17', 'decision', 'safety'),
  ('Plebiscite: ban open-air hard drug use in public spaces',                    'city', 'vancouver', date '2026-10-17', 'decision', 'safety'),
  ('Plebiscite: secure mental-health & addictions care facility (St. Paul''s)', 'city', 'vancouver', date '2026-10-17', 'decision', 'health')
) v(name, level, region, vote_date, kind, topic)
where not exists (select 1 from elections e where e.name = v.name);

-- strip needs room for all same-day questions; client groups them
create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
             'vote_date', vote_date, 'days', (vote_date - current_date)) as j
    from elections
    where vote_date >= current_date and vote_date <= current_date + 400
      and lower(coalesce(p_place,'')) like '%' || region || '%'
    order by vote_date asc, kind desc limit 12
  ) s;
$$;

-- entry chip: on a same-day tie, the topic-matched decision wins (green over red)
create or replace function vp_find_moment(p_place text, p_topic text default null)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date))
  from elections
  where vote_date >= current_date
    and lower(coalesce(p_place,'')) like '%' || region || '%'
    and (kind = 'election' or (p_topic is not null and topic = p_topic))
  order by vote_date asc, (kind = 'decision') desc limit 1;
$$;
