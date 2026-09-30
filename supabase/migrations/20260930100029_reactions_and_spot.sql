-- (A) Precise spot on an issue (opt-in per issue): street-level label + coordinates (rounded client-side)
alter table entries add column if not exists lat double precision;
alter table entries add column if not exists lng double precision;
alter table entries add column if not exists spot text;

drop function if exists vp_add_entry(text, text, boolean, jsonb, text);
create or replace function vp_add_entry(p_tail text, p_body text, p_shared boolean,
                                        p_media jsonb default '[]'::jsonb, p_place text default null,
                                        p_lat double precision default null, p_lng double precision default null, p_spot text default null)
returns json language plpgsql security definer set search_path = public as $$
declare b text; new_id uuid; t text; m jsonb; clean jsonb := '[]'::jsonb; sp text;
begin
  b := coalesce(trim(p_body), '');
  if length(b) > 500 then raise exception 'body must be at most 500 chars'; end if;
  if jsonb_typeof(coalesce(p_media,'[]'::jsonb)) <> 'array' then raise exception 'bad media'; end if;
  if jsonb_array_length(coalesce(p_media,'[]'::jsonb)) > 4 then raise exception 'max 4 files'; end if;
  for m in select * from jsonb_array_elements(coalesce(p_media,'[]'::jsonb)) loop
    if coalesce(m->>'path','') !~ '^[0-9a-f-]{8,40}\.[a-z0-9]{1,5}$'
       or coalesce(m->>'type','') !~ '^(image|video)/[a-z0-9.+-]+$' then
      raise exception 'bad media item';
    end if;
    clean := clean || jsonb_build_array(jsonb_build_object('path', m->>'path', 'type', m->>'type'));
  end loop;
  if length(b) = 0 and jsonb_array_length(clean) = 0 then raise exception 'say it or show it'; end if;
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'bad location'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then raise exception 'bad location'; end if;
  sp := nullif(left(trim(coalesce(p_spot,'')), 80), '');
  t := case when length(b) > 0 then vp_guess_topic(b) end;
  insert into entries(tail, body, shared, media, place, topic, topic_src, lat, lng, spot)
    values (p_tail, b, coalesce(p_shared,false), clean, nullif(trim(coalesce(p_place,'')),''), t,
            case when t is not null then 'rule' end, round(p_lat::numeric, 4), round(p_lng::numeric, 4), sp)
    returning id into new_id;
  return json_build_object('id', new_id, 'topic', t);
end $$;
grant execute on function vp_add_entry(text, text, boolean, jsonb, text, double precision, double precision, text) to anon;

-- (B) Reactions from neighbours: one status per pup per issue, latest wins
create table if not exists reacts (
  entry_id   uuid not null references entries(id) on delete cascade,
  tail       text not null references ledgers(tail) on delete cascade,
  kind       text not null check (kind in ('still','fixed')),
  created_at timestamptz not null default now(),
  primary key (entry_id, tail)
);
alter table reacts enable row level security;
grant all on reacts to service_role;

create or replace function vp_react(p_tail text, p_id uuid, p_kind text)
returns json language plpgsql security definer set search_path = public as $$
declare e entries%rowtype;
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  select * into e from entries where id = p_id;
  if not found or not e.shared then raise exception 'that issue is not shared'; end if;
  if e.tail = p_tail then raise exception 'that one is yours'; end if;
  if p_kind is null then
    delete from reacts where entry_id = p_id and tail = p_tail;
  else
    if p_kind not in ('still','fixed') then raise exception 'bad reaction'; end if;
    if (select count(*) from reacts where tail = p_tail and created_at > now() - interval '1 day') >= 200 then
      raise exception 'that is a lot for one day - try tomorrow'; end if;
    insert into reacts(entry_id, tail, kind) values (p_id, p_tail, p_kind)
      on conflict (entry_id, tail) do update set kind = excluded.kind, created_at = now();
  end if;
  return json_build_object('still', (select count(*) from reacts where entry_id = p_id and kind = 'still'),
                           'fixed', (select count(*) from reacts where entry_id = p_id and kind = 'fixed'),
                           'mine', (select kind from reacts where entry_id = p_id and tail = p_tail));
end $$;
revoke all on function vp_react(text, uuid, text) from public;
grant execute on function vp_react(text, uuid, text) to anon;

-- (C) counts + spot everywhere issues are read
create or replace function vp_shared_board(p_place text default null)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('id', e.id, 'body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place, 'spot', e.spot, 'lat', e.lat, 'lng', e.lng,
                             'backs', (select count(*) from backs b where b.entry_id = e.id),
                             'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
                             'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'),
                             'fixed_at', e.fixed_at) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared
      and (p_place is null
           or lower(trim(split_part(coalesce(e.place,''),',',1))) = lower(trim(split_part(p_place,',',1))))
    order by e.created_at desc limit 100
  ) s;
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
           'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'))
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

create or replace function vp_get_view(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json; city text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{20}$' then return null; end if;
  select * into l from ledgers where view_token = p_token;
  if not found then return null; end if;
  select split_part(place, ',', 1) into city from entries
    where tail = l.tail and place is not null order by created_at desc limit 1;
  select coalesce(json_agg(json_build_object(
           'body', body, 'ts', created_at, 'media', media, 'topic', topic, 'spot', spot, 'fixed_at', fixed_at,
           'backs', (select count(*) from backs b where b.entry_id = entries.id))
           order by created_at desc), '[]'::json)
    into es from entries where tail = l.tail and (shared or l.view_all);
  return json_build_object('name', l.name, 'city', city, 'entries', es);
end $$;
