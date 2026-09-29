-- Blue tier from Shape Your City: scope (site vs city), dedupe key, seen-tracker, capped strip, cron
alter table elections add column if not exists scope text not null default 'city';
alter table elections add column if not exists source_url text;
create unique index if not exists elections_source_url_uq on elections(source_url);

create table if not exists syc_seen (
  slug text primary key,
  checked_at timestamptz not null default now(),
  has_window boolean not null default false
);
alter table syc_seen enable row level security;
grant all on syc_seen to service_role;
grant all on elections to service_role;
grant usage, select on all sequences in schema public to service_role;

-- strip: ALL elections + decisions in horizon, plus at most 40 soonest voice rows (so voice can't crowd out ballots)
create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  with base as (
    select * from elections
    where vote_date >= current_date and vote_date <= current_date + 400
      and lower(coalesce(p_place,'')) like '%' || region || '%'
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

-- entry chips: address-level (site) voice rows never hijack a city-wide gripe
create or replace function vp_find_moment(p_place text, p_topic text default null)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
           'vote_date', vote_date, 'days', (vote_date - current_date),
           'actions', actions, 'how', case when how_ok then how end)
  from elections
  where vote_date >= current_date
    and lower(coalesce(p_place,'')) like '%' || region || '%'
    and (kind = 'election'
         or (p_topic is not null and topic = p_topic and (kind <> 'voice' or scope = 'city')))
  order by vote_date asc, (kind <> 'election') desc limit 1;
$$;

select cron.unschedule('sync-voice-every-2h') where exists
  (select 1 from cron.job where jobname = 'sync-voice-every-2h');
select cron.schedule('sync-voice-every-2h', '15 */2 * * *',
  $$ select net.http_post(
       url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/sync-voice',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$);
