-- Three tiers: election (red) | decision (green) | voice (blue)
-- actions = curated official links (never model-generated); how = LLM draft, shown only when how_ok
alter table elections add column if not exists actions jsonb not null default '[]'::jsonb;
alter table elections add column if not exists how text;
alter table elections add column if not exists how_ok boolean not null default false;

-- Curated, verified links
update elections set actions = '[
  {"label":"Voter guide: where, when, what ID","url":"https://vancouver.ca/your-government/2026-voters-guide.aspx"},
  {"label":"Advance voting: Oct 3, 7, 10, 13 (8am-8pm)","url":"https://vancouver.ca/your-government/2026-voters-guide.aspx"}
]'::jsonb where name = 'Vancouver municipal election';

update elections set actions = '[
  {"label":"Elections BC: register, where & how to vote","url":"https://elections.bc.ca/"}
]'::jsonb where name = 'BC provincial election';

update elections set actions = '[
  {"label":"Elections Canada","url":"https://www.elections.ca/"}
]'::jsonb where name = 'Canadian federal election';

update elections set actions = '[
  {"label":"Read the exact ballot questions","url":"https://vancouver.ca/your-government/2026-capital-plan-borrowing-questions-and-plebiscite-questions.aspx"},
  {"label":"Voter guide + advance voting (Oct 3, 7, 10, 13)","url":"https://vancouver.ca/your-government/2026-voters-guide.aspx"}
]'::jsonb where kind = 'decision' and region = 'vancouver' and vote_date = date '2026-10-17';

create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
             'vote_date', vote_date, 'days', (vote_date - current_date),
             'actions', actions, 'how', case when how_ok then how end) as j
    from elections
    where vote_date >= current_date and vote_date <= current_date + 400
      and lower(coalesce(p_place,'')) like '%' || region || '%'
    order by vote_date asc, kind desc limit 20
  ) s;
$$;

create or replace function vp_find_moment(p_place text, p_topic text default null)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date),
           'actions', actions, 'how', case when how_ok then how end)
  from elections
  where vote_date >= current_date
    and lower(coalesce(p_place,'')) like '%' || region || '%'
    and (kind = 'election' or (p_topic is not null and topic = p_topic))
  order by vote_date asc, (kind <> 'election') desc limit 1;
$$;

-- BLUE TIER curation pattern (paste real items from shapeyourcity.ca / council agendas):
-- insert into elections(name, level, region, vote_date, kind, topic, actions) values
--  ('Have your say: <consultation title>', 'city', 'vancouver', date '2026-10-20', 'voice', 'housing',
--   '[{"label":"Answer the consultation","url":"https://www.shapeyourcity.ca/<project>"}]');
-- ('Public hearing: <address> rezoning', ..., 'voice', 'housing',
--   '[{"label":"Sign up to speak","url":"https://vancouver.ca/your-government/speak-at-city-council-meetings.aspx"},
--     {"label":"Send council a comment","url":"https://vancouver.ca/your-government/contact-council-public-hearing.aspx"}]');
