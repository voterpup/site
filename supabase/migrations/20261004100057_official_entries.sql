-- Official 3-1-1 reports become real, shared issues on the board (same here, reactions, share, fixed now, sorting),
-- posted by one system pup per city and marked with source = 'city311'. Backfilled after every sync.
alter table entries add column if not exists source text;
-- server jobs (no visitor connection) and official posts are never rate-limited
create or replace function vp_guard_entry() returns trigger language plpgsql security definer set search_path = public as $g$
declare c text := vp_conn();
begin
  if c is null or new.source is not null then return new; end if;
  if tg_op = 'INSERT' then
    perform vp_limit('post_pup', new.tail, 30, interval '1 day', 'Your pup has had a big day. Try again tomorrow.');
    perform vp_limit('post_conn', c, 120, interval '1 day', 'Lots of posts from this connection today. Try again tomorrow.');
  end if;
  if new.shared and (tg_op = 'INSERT' or not coalesce(old.shared, false)) then
    perform vp_limit('share_pup', new.tail, 10, interval '1 day', 'That is a lot of sharing for one day. Keep it private for now, or share tomorrow.');
    perform vp_limit('share_conn', c, 40, interval '1 day', 'Lots of shared posts from this connection today. Try again tomorrow.');
  end if;
  return new;
end $g$;
alter table entries add column if not exists ext_id text;
create unique index if not exists entries_ext_id on entries (ext_id) where ext_id is not null;
create index if not exists entries_source_place on entries (source, created_at desc) where source is not null;

create or replace function vp_official_tail(p_city text) returns text language sql immutable as $$
  select 'official-' || regexp_replace(lower(p_city), '[^a-z0-9]+', '-', 'g') || '~311';
$$;

create or replace function vp_official_backfill(p_per_city int default 40) returns json language plpgsql security definer set search_path = public as $$
declare n_in int := 0; n_out int := 0; c record;
begin
  for c in select distinct city from city_pins loop
    insert into ledgers(tail, name) values (vp_official_tail(c.city), left('City of ' || initcap(c.city) || ' 3-1-1', 24)) on conflict (tail) do nothing;
    with latest as (select * from city_pins p where p.city = c.city and p.lat is not null order by ts desc limit p_per_city),
    ins as (
      insert into entries(tail, body, shared, media, topic, topic_src, place, lat, lng, spot, created_at, source, ext_id)
      select vp_official_tail(c.city), left(regexp_replace(rtype, ' Case$', ''), 200), true, '[]'::jsonb, topic, 'city',
             initcap(c.city), lat, lng, left(area, 80), ts, 'city311', id
      from latest on conflict do nothing returning 1)
    select n_in + count(*) into n_in from ins;
  end loop;
  -- keep the board fresh: official issues nobody engaged with go after 14 days; anything goes after 45
  with del as (delete from entries e where e.source = 'city311' and (
      e.created_at < now() - interval '45 days'
      or (e.created_at < now() - interval '14 days' and not exists (select 1 from backs b where b.entry_id = e.id) and not exists (select 1 from emoji_reacts r where r.entry_id = e.id)))
    returning 1)
  select count(*) into n_out from del;
  return json_build_object('added', n_in, 'removed', n_out);
end $$;
revoke all on function vp_official_backfill(int) from public, anon, authenticated;

-- the board: people's posts as before, plus the newest official issues (40 for one city, 6 per city everywhere)
create or replace function vp_shared_board(p_place text default null)
returns json language sql security definer set search_path = public as $$
  with c as (select lower(trim(split_part(coalesce(p_place,''), ',', 1))) city),
  people as (select e.* from entries e, c where e.shared and e.source is null
               and (p_place is null or lower(trim(split_part(coalesce(e.place,''),',',1))) = c.city)
             order by e.created_at desc limit 100),
  official as (select * from (select e.*, row_number() over (partition by e.tail order by e.created_at desc) rn
                 from entries e, c where e.shared and e.source = 'city311'
                   and (p_place is null or lower(trim(split_part(coalesce(e.place,''),',',1))) = c.city)) q
               where rn <= (case when p_place is null then 6 else 40 end)),
  rows as (select id, tail, body, created_at, media, topic, place, spot, lat, lng, tags, fixed_at, source from people
           union all select id, tail, body, created_at, media, topic, place, spot, lat, lng, tags, fixed_at, source from official)
  select coalesce(json_agg(j order by (j->>'ts') desc), '[]'::json) from (
    select json_build_object('id', e.id, 'body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place, 'spot', e.spot, 'lat', e.lat, 'lng', e.lng, 'tags', e.tags,
                             'source', e.source,
                             'backs', (select count(*) from backs b where b.entry_id = e.id),
                             'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
                             'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'),
                             'fixed_at', e.fixed_at) as j
    from rows e join ledgers l on l.tail = e.tail) s;
$$;

-- people-only counts stay people-only
create or replace function vp_place_stats(p_place text) returns json language sql security definer set search_path = public as $$
  with c as (select lower(trim(split_part(coalesce(p_place,''), ',', 1))) city),
  e as (select * from entries, c where created_at > now() - interval '7 days' and source is null
          and lower(trim(split_part(coalesce(place,''), ',', 1))) = c.city),
  t as (select topic, count(*) n from e where topic is not null and topic <> 'other' group by topic order by n desc limit 1)
  select json_build_object('pups_week', (select count(distinct tail) from e), 'issues_week', (select count(*) from e),
                           'top_topic', (select topic from t), 'top_count', (select n from t));
$$;
create or replace function vp_recent_pups(p_n int default 30) returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(r order by r.created desc), '[]'::json) from (
    select l.name, l.created_at created,
      coalesce((select src from events c where c.tail = l.tail and c.event = 'pup_created' order by ts limit 1), (select src from events c where c.tail = l.tail order by ts limit 1)) src,
      (select count(*) from entries x where x.tail = l.tail) issues, (select left(body, 50) from entries x where x.tail = l.tail order by created_at limit 1) first,
      exists (select 1 from push_subs p where p.tail = l.tail) push, exists (select 1 from mail_subs m where m.tail = l.tail and m.unsub_at is null) mail,
      (select count(distinct (ts at time zone 'America/Vancouver')::date) from events c where c.tail = l.tail) days_active
    from ledgers l
    where l.tail not like 'official-%'
      and not exists (select 1 from events x join internal_devs i on i.dev = x.dev where x.tail = l.tail)
    order by l.created_at desc limit p_n) r;
$$;
revoke all on function vp_recent_pups(int) from public, anon, authenticated; grant execute on function vp_recent_pups(int) to service_role;

select vp_official_backfill();
