-- Two-tier moments: candidate elections vs topic decision-votes + BC 2026 correction
alter table elections add column if not exists kind text not null default 'election';
alter table elections add column if not exists topic text;

update elections set vote_date = date '2026-10-24', name = 'BC provincial election'
  where region = 'british columbia';

-- place-level soonest moment (vote strip)
create or replace function vp_find_election(p_place text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date))
  from elections
  where vote_date >= current_date
    and lower(coalesce(p_place,'')) like '%' || region || '%'
  order by vote_date asc limit 1;
$$;

-- entry-level soonest moment: topic-matched decisions beat/join elections by date
create or replace function vp_find_moment(p_place text, p_topic text default null)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date))
  from elections
  where vote_date >= current_date
    and lower(coalesce(p_place,'')) like '%' || region || '%'
    and (kind = 'election'
         or topic is null
         or (p_topic is not null and topic = p_topic))
  order by vote_date asc limit 1;
$$;
grant execute on function vp_find_election(text) to anon;
grant execute on function vp_find_moment(text, text) to anon;

-- Hand-curation pattern for council decision votes (the November loop, manual until automated):
-- insert into elections(name, level, region, vote_date, kind, topic)
-- values ('Council vote: Broadway bike lanes', 'council', 'vancouver', date '2026-10-08', 'decision', 'transit');
