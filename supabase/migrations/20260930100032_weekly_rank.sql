-- "Your issue climbed": weekly rank of a shared issue within its city, by 'same here' received this week.
create or replace function vp_weekly_rank(p_id uuid)
returns int language sql stable security definer set search_path = public as $$
  with me as (select id, lower(trim(split_part(coalesce(place,''), ',', 1))) city from entries where id = p_id and shared),
  score as (
    select e.id, count(b.entry_id) filter (where b.created_at > now() - interval '7 days') wk, count(b.entry_id) total, e.created_at
    from entries e left join backs b on b.entry_id = e.id, me
    where e.shared and lower(trim(split_part(coalesce(e.place,''), ',', 1))) = me.city
    group by e.id, e.created_at)
  select case when (select wk from score where id = p_id) > 0
    then (select 1 + count(*) from score s, (select wk, total, created_at from score where id = p_id) m
          where s.id <> p_id and (s.wk > m.wk or (s.wk = m.wk and (s.total > m.total or (s.total = m.total and s.created_at > m.created_at)))))::int
    else null end;
$$;

create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json; bk json; rx json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'shared', e.shared, 'ts', e.created_at,
           'media', e.media, 'topic', e.topic, 'place', e.place, 'fixed_at', e.fixed_at,
           'spot', e.spot, 'lat', e.lat, 'lng', e.lng,
           'backs', (select count(*) from backs b where b.entry_id = e.id),
           'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
           'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'),
           'rank', case when e.shared then vp_weekly_rank(e.id) end,
           'city', split_part(coalesce(e.place,''), ',', 1))
           order by e.created_at desc), '[]'::json)
    into es from entries e where e.tail = p_tail;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'ts', e.created_at, 'topic', e.topic, 'place', e.place,
           'media', e.media, 'pup', o.name, 'backed_at', b.created_at, 'fixed_at', e.fixed_at,
           'spot', e.spot, 'lat', e.lat, 'lng', e.lng,
           'backs', (select count(*) from backs x where x.entry_id = e.id),
           'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
           'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'))
           order by b.created_at desc), '[]'::json)
    into bk from backs b join entries e on e.id = b.entry_id join ledgers o on o.tail = e.tail
    where b.tail = p_tail and e.shared;
  select coalesce(json_object_agg(entry_id, kind), '{}'::json) into rx from reacts where tail = p_tail;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es, 'backed', bk, 'reacts', rx);
end $$;

create or replace function vp_reminder_facts(p_tail text)
returns json language sql security definer set search_path = public as $$
  with mine as (select * from entries where tail = p_tail),
  place as (select place from mine where place is not null order by created_at desc limit 1),
  s as (select vp_place_stats((select place from place)) st),
  ranked as (select body, vp_weekly_rank(id) rk, split_part(coalesce(place,''), ',', 1) city from mine where shared),
  best as (select * from ranked where rk is not null order by rk asc limit 1)
  select json_build_object('entries', (select count(*) from mine),
                           'backs', (select count(*) from backs b join mine m on m.id = b.entry_id),
                           'city', split_part((select place from place), ',', 1),
                           'stats', (select st from s),
                           'top', (select json_build_object('body', body, 'rank', rk, 'city', city) from best));
$$;
