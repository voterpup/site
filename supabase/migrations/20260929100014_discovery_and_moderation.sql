-- (A) Discovered moments must be verified before anyone sees them.
alter table elections add column if not exists status text not null default 'live';
alter table elections drop constraint if exists elections_status_chk;
alter table elections add constraint elections_status_chk check (status in ('live','unverified','rejected'));
alter table elections add column if not exists parent text;        -- city rows: province/state (lowercase)
alter table elections add column if not exists dkey text;          -- discovery dedupe key
alter table elections add column if not exists source_quote text;  -- verbatim text the date was verified against
alter table elections add column if not exists discovered_at timestamptz;
create unique index if not exists elections_dkey_uq on elections(dkey) where dkey is not null;

-- existing city rows are all in BC (so "Vancouver, Washington" no longer matches them)
update elections set parent = 'british columbia' where level in ('city','council') and parent is null;

create or replace function vp_place_match(p_place text, p_level text, p_region text, p_parent text)
returns boolean language sql immutable as $$
  with p as (select array(select lower(trim(x)) from unnest(string_to_array(coalesce(p_place,''), ',')) x) a)
  select case
    when p_level in ('city','council') then a[1] = p_region and (p_parent is null or coalesce(a[2],'') = p_parent)
    when p_level = 'province' then coalesce(a[2], '') = p_region
    when p_level = 'federal'  then coalesce(a[array_length(a,1)], '') = p_region
    else false end
  from p;
$$;

create or replace function vp_find_election(p_place text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date))
  from elections
  where status = 'live' and vote_date >= current_date and vp_place_match(p_place, level, region, parent)
  order by vote_date asc limit 1;
$$;

create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  with base as (
    select * from elections
    where status = 'live' and vote_date >= current_date and vote_date <= current_date + 400
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
  where status = 'live' and vote_date >= current_date
    and vp_place_match(p_place, level, region, parent)
    and (kind = 'election'
         or (p_topic is not null and topic = p_topic and (kind <> 'voice' or scope = 'city')))
  order by vote_date asc, (kind <> 'election') desc limit 1;
$$;

-- (B) Places people actually use -> the discovery job's work queue.
create table if not exists place_watch (
  place          text primary key,             -- exact app label, e.g. "Burnaby, British Columbia, Canada"
  first_seen     timestamptz not null default now(),
  last_requested timestamptz not null default now(),
  requests       int not null default 1,
  last_checked   timestamptz,
  next_check     timestamptz not null default now(),
  checks         int not null default 0,
  last_result    text
);
create table if not exists discovery_log (
  id         bigserial primary key,
  run_at     timestamptz not null default now(),
  place      text,
  cost_usd   numeric(10,4) not null default 0,
  input_tokens int, output_tokens int, searches int,
  found int, published int, rejected int,
  note text
);
alter table place_watch enable row level security;
alter table discovery_log enable row level security;
grant all on place_watch, discovery_log to service_role;
grant usage, select on all sequences in schema public to service_role;

-- anon: record a place. Validated label shape; at most 100 NEW places per day across everyone.
create or replace function vp_note_place(p_place text)
returns void language plpgsql security definer set search_path = public as $$
declare p text := trim(coalesce(p_place, ''));
begin
  if length(p) < 3 or length(p) > 120 then return; end if;
  if p !~ '^[[:alpha:][:space:].''’()-]+(, [[:alpha:][:space:].''’()-]+){1,3}$' then return; end if;
  update place_watch set last_requested = now(), requests = requests + 1 where place = p;
  if found then return; end if;
  if (select count(*) from place_watch where first_seen > now() - interval '1 day') >= 100 then return; end if;
  insert into place_watch(place) values (p) on conflict (place) do nothing;
end $$;
revoke all on function vp_note_place(text) from public;
grant execute on function vp_note_place(text) to anon;

-- (C) Image moderation queue: publicly visible entries with media not yet reviewed.
create or replace function vp_mod_queue(p_limit int default 200)
returns table(id uuid, media jsonb) language sql security definer set search_path = public as $$
  select e.id, e.media from entries e join ledgers l on l.tail = e.tail
  where (e.shared or l.view_all)
    and exists (select 1 from jsonb_array_elements(e.media) m where not (m ? 'mod'))
  order by e.created_at desc limit p_limit;
$$;
revoke all on function vp_mod_queue(int) from public, anon, authenticated;
grant execute on function vp_mod_queue(int) to service_role;

-- kick the reviewer the moment something becomes public (async; never blocks the write)
create or replace function vp_kick_moderation() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/moderate-media',
                        headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);
  return null;
end $$;
drop trigger if exists entries_kick_moderation on entries;
create trigger entries_kick_moderation after insert or update of shared on entries
  for each row when (new.shared and jsonb_array_length(new.media) > 0)
  execute function vp_kick_moderation();

-- sweep: catches failures, view_all flips, and anything the trigger missed
select cron.unschedule('moderate-media-5min') where exists (select 1 from cron.job where jobname = 'moderate-media-5min');
select cron.schedule('moderate-media-5min', '*/5 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/moderate-media',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$);
