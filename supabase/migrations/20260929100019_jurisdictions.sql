-- Onboarded localities, split into shared JURISDICTIONS (city / state-province / country).
-- A state or country is checked once and reused by every city in it; each jurisdiction also keeps
-- its own official election office link, so a country-wide row never carries one city's link.
create table if not exists jurisdictions (
  level        text not null check (level in ('city','province','federal')),
  region       text not null,               -- lowercase: 'austin' / 'texas' / 'united states'
  parent       text not null default '',    -- city: its state; state: its country; country: ''
  label        text,                        -- display name, e.g. 'Austin' / 'Texas' / 'United States'
  office_label text,                        -- e.g. 'Travis County Elections'
  office_url   text,                        -- verified official page
  first_seen   timestamptz not null default now(),
  last_checked timestamptz,
  next_check   timestamptz not null default now(),
  checks       int not null default 0,
  last_result  text,
  primary key (level, region, parent)
);
alter table jurisdictions enable row level security;
grant all on jurisdictions to service_role;

-- localities (place_watch) get their parts, so a place maps to its three jurisdictions
alter table place_watch add column if not exists city text;
alter table place_watch add column if not exists province text;
alter table place_watch add column if not exists country text;
update place_watch set
  city     = lower(trim(split_part(place, ',', 1))),
  province = case when array_length(string_to_array(place, ','), 1) >= 3 then lower(trim(split_part(place, ',', 2))) end,
  country  = lower(trim((string_to_array(place, ','))[array_length(string_to_array(place, ','), 1)]))
where city is null;

-- Estimated moments: an official source says roughly when (e.g. "due by late 2027") but no date is set.
alter table elections add column if not exists date_precision text not null default 'day';
alter table elections drop constraint if exists elections_precision_chk;
alter table elections add constraint elections_precision_chk check (date_precision in ('day','month','year'));
alter table elections add column if not exists estimate_note text;

-- the national US row: national link, not one county's
update elections set actions = '[{"label":"Vote.gov: register, find your election office","url":"https://vote.gov/"}]'::jsonb
  where level = 'federal' and region = 'united states' and vote_date = date '2026-11-03' and kind = 'election';

-- confirmed moments within ~13 months, plus estimated ones up to ~30 months (clearly flagged)
create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  with base as (
    select * from elections
    where status = 'live' and vote_date >= current_date
      and (vote_date <= current_date + 400 or (date_precision <> 'day' and vote_date <= current_date + 900))
      and vp_place_match(p_place, level, region, parent)
  ),
  picked as (
    (select * from base where kind <> 'voice')
    union all
    (select * from base where kind = 'voice' order by vote_date asc limit 40)
  )
  select coalesce(json_agg(json_build_object(
           'name', name, 'level', level, 'kind', kind, 'topic', topic, 'scope', scope,
           'vote_date', vote_date, 'days', (vote_date - current_date), 'source_url', source_url,
           'actions', actions, 'how', case when how_ok then how end,
           'estimated', date_precision <> 'day', 'estimate_note', estimate_note)
         order by vote_date asc, kind desc), '[]'::json)
  from picked;
$$;

-- countdown chips on entries use confirmed dates only
create or replace function vp_find_election(p_place text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date))
  from elections
  where status = 'live' and date_precision = 'day' and vote_date >= current_date
    and vp_place_match(p_place, level, region, parent)
  order by vote_date asc limit 1;
$$;
create or replace function vp_find_moment(p_place text, p_topic text default null)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date),
           'actions', actions, 'how', case when how_ok then how end)
  from elections
  where status = 'live' and date_precision = 'day' and vote_date >= current_date
    and vp_place_match(p_place, level, region, parent)
    and (kind = 'election'
         or (p_topic is not null and topic = p_topic and (kind <> 'voice' or scope = 'city')))
  order by vote_date asc, (kind <> 'election') desc limit 1;
$$;

-- the election offices that serve a place: city (or county), state/province, country
create or replace function vp_offices(p_place text)
returns json language sql security definer set search_path = public as $$
  with p as (select array(select lower(trim(x)) from unnest(string_to_array(coalesce(p_place,''), ',')) x) a),
  k as (
    select 1 o, 'city' lv, a[1] rg, case when array_length(a,1) >= 3 then a[2] else '' end pr from p
    union all select 2, 'province', a[2], a[array_length(a,1)] from p where array_length(a,1) >= 3
    union all select 3, 'federal', a[array_length(a,1)], '' from p
  )
  select coalesce(json_agg(json_build_object('level', j.level, 'label', j.office_label, 'url', j.office_url) order by k.o), '[]'::json)
  from k join jurisdictions j on j.level = k.lv and j.region = k.rg and j.parent = k.pr
  where j.office_url is not null;
$$;
grant execute on function vp_offices(text) to anon;
