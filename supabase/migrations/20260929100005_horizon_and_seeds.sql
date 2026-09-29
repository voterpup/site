-- Strip shows actionable horizon only (13 months); far-future stays in the table for entry matching
create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
             'vote_date', vote_date, 'days', (vote_date - current_date)) as j
    from elections
    where vote_date >= current_date
      and vote_date <= current_date + 400
      and lower(coalesce(p_place,'')) like '%' || region || '%'
    order by vote_date asc limit 4
  ) s;
$$;

-- SEED PATTERNS (uncomment + edit after verifying on vancouver.ca/vote and council agendas):
-- Ballot questions on the Oct 17 ballot (citizens vote -> kind 'decision', green timer):
-- insert into elections(name, level, region, vote_date, kind, topic) values
--   ('Ballot question: capital plan borrowing (parks)', 'city', 'vancouver', date '2026-10-17', 'decision', 'parks');
-- Council decision votes (councillors vote; citizens attend/speak):
-- insert into elections(name, level, region, vote_date, kind, topic) values
--   ('Council vote: <agenda item>', 'council', 'vancouver', date '2026-10-08', 'decision', 'transit');
