-- (A) EXACT place matching by level (fixes "North Vancouver" / Metro Vancouver matching Vancouver's votes)
create or replace function vp_place_match(p_place text, p_level text, p_region text)
returns boolean language sql immutable as $$
  with p as (select array(select lower(trim(x)) from unnest(string_to_array(coalesce(p_place,''), ',')) x) a)
  select case
    when p_level in ('city','council') then a[1] = p_region
    when p_level = 'province' then coalesce(a[2], '') = p_region
    when p_level = 'federal'  then coalesce(a[array_length(a,1)], '') = p_region
    else false end
  from p;
$$;

-- old geocoder labels: the only such entries are the founder's own Vancouver entries
update entries set place = 'Vancouver, British Columbia, Canada'
  where place ilike 'Metro Vancouver Regional District%';

create or replace function vp_find_election(p_place text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date))
  from elections
  where vote_date >= current_date and vp_place_match(p_place, level, region)
  order by vote_date asc limit 1;
$$;

create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  with base as (
    select * from elections
    where vote_date >= current_date and vote_date <= current_date + 400
      and vp_place_match(p_place, level, region)
  ),
  picked as (
    (select * from base where kind <> 'voice')
    union all
    (select * from base where kind = 'voice' order by vote_date asc limit 40)
  )
  select coalesce(json_agg(json_build_object(
           'name', name, 'level', level, 'kind', kind, 'topic', topic, 'scope', scope,
           'vote_date', vote_date, 'days', (vote_date - current_date), 'source_url', source_url,
           'actions', actions, 'how', case when how_ok then how end)
         order by vote_date asc, kind desc), '[]'::json)
  from picked;
$$;

create or replace function vp_find_moment(p_place text, p_topic text default null)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date),
           'actions', actions, 'how', case when how_ok then how end)
  from elections
  where vote_date >= current_date
    and vp_place_match(p_place, level, region)
    and (kind = 'election'
         or (p_topic is not null and topic = p_topic and (kind <> 'voice' or scope = 'city')))
  order by vote_date asc, (kind <> 'election') desc limit 1;
$$;

create or replace function vp_shared_board(p_place text default null)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared
      and (p_place is null
           or lower(trim(split_part(coalesce(e.place,''),',',1))) = lower(trim(split_part(p_place,',',1))))
    order by e.created_at desc limit 100
  ) s;
$$;

-- (B) Fuller topic list: + infrastructure, utilities, education.  \m = word start, \M = word end.
create or replace function vp_guess_topic(p text)
returns text language sql immutable as $$
  select case
    when p ~* '\m(tents?|encampments?|homeless(ness)?|unhoused|shelters?|sleeping rough)\M' then 'homelessness'
    when p ~* '\m(hospitals?|doctors?|clinics?|health|hygiene|unhygienic|mental|overdoses?|nurses?|pharmac\w*|er wait)\M' then 'health'
    when p ~* '\m(water|power|electricity|outages?|blackouts?|power cuts?|sewage|sewers?|drainage|internet|load.?shedding)\M' then 'utilities'
    when p ~* '\m(sidewalks?|potholes?|roads?|bridges?|railings?|streetlights?|street lights?|icy|ice|snow|construction|curbs?|pavements?|signage|traffic lights?)\M' then 'infrastructure'
    when p ~* '\m(bus|buses|trains?|skytrain|transit|traffic|bikes?|cycling|cyclists?|parking|commute|pedestrians?|speeding|intersections?)\M' then 'transit'
    when p ~* '\m(rent|rents|renters?|landlords?|housing|apartments?|condos?|evict\w*|mortgages?|rezoning|density|home prices?)\M' then 'housing'
    when p ~* '\m(schools?|teachers?|classrooms?|universit(y|ies)|colleges?|tuition|daycare|childcare)\M' then 'education'
    when p ~* '\m(crime|theft|stolen|break.?ins?|unsafe|police|assaults?|drugs?|needles?|violence|robber(y|ies))\M' then 'safety'
    when p ~* '\m(garbage|trash|litter\w*|dirty|graffiti|smell\w*|poop|waste|recycling|filthy)\M' then 'cleanliness'
    when p ~* '\m(parks?|playgrounds?|trees?|beach(es)?|off.?leash|gardens?|pools?|community cent\w*|rinks?|librar(y|ies))\M' then 'parks'
    when p ~* '\m(climate|pollution|emissions?|heat ?waves?|smoke|air quality|floods?|flooding|noise|noisy)\M' then 'climate'
    when p ~* '\m(prices?|expensive|costs?|grocer\w*|tax|taxes|fees?|inflation|wages?|afford\w*)\M' then 'cost of living'
    else 'other'
  end;
$$;

create or replace function vp_set_topic(p_tail text, p_id uuid, p_topic text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_topic not in ('housing','homelessness','transit','infrastructure','utilities','safety','cost of living',
                     'health','education','climate','cleanliness','parks','other') then
    raise exception 'unknown topic'; end if;
  update entries set topic = p_topic, topic_src = 'user' where id = p_id and tail = p_tail;
end $$;
grant execute on function vp_set_topic(text, uuid, text) to anon;

-- retag ONLY non-user "other" entries; 'rule' lets Haiku re-refine the shared ones
update entries set topic = vp_guess_topic(body), topic_src = 'rule'
  where topic = 'other' and coalesce(topic_src,'') <> 'user' and length(coalesce(body,'')) > 0;

update elections set topic = 'infrastructure' where name like 'Borrowing Q: $292M bridges%';
