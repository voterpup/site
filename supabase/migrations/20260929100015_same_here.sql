-- "Same here": a pup backs someone else's SHARED issue. One back per pup per issue; the backed
-- issue also appears in the backer's own pup, so it resurfaces for them at voting time.
create table if not exists backs (
  entry_id   uuid not null references entries(id) on delete cascade,
  tail       text not null references ledgers(tail) on delete cascade,
  created_at timestamptz not null default now(),
  place      text,   -- backer's place when they backed it: lets counts be split local / province / national later
  primary key (entry_id, tail)
);
create index if not exists backs_tail_idx on backs(tail);
alter table backs enable row level security;
grant all on backs to service_role;

create or replace function vp_back(p_tail text, p_id uuid, p_on boolean, p_place text default null)
returns json language plpgsql security definer set search_path = public as $$
declare e entries%rowtype;
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  select * into e from entries where id = p_id;
  if not found or not e.shared then raise exception 'that issue is not shared'; end if;
  if e.tail = p_tail then raise exception 'that one is yours'; end if;
  if coalesce(p_on, true) then
    if (select count(*) from backs where tail = p_tail and created_at > now() - interval '1 day') >= 100 then
      raise exception 'that is a lot of backing for one day - try tomorrow';
    end if;
    insert into backs(entry_id, tail, place) values (p_id, p_tail, nullif(left(trim(coalesce(p_place,'')), 120), ''))
      on conflict do nothing;
  else
    delete from backs where entry_id = p_id and tail = p_tail;
  end if;
  return json_build_object('backs', (select count(*) from backs where entry_id = p_id),
                           'backed', exists (select 1 from backs where entry_id = p_id and tail = p_tail));
end $$;
revoke all on function vp_back(text, uuid, boolean, text) from public;
grant execute on function vp_back(text, uuid, boolean, text) to anon;

-- Pack rows carry id + backing count
create or replace function vp_shared_board(p_place text default null)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('id', e.id, 'body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place,
                             'backs', (select count(*) from backs b where b.entry_id = e.id)) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared
      and (p_place is null
           or lower(trim(split_part(coalesce(e.place,''),',',1))) = lower(trim(split_part(p_place,',',1))))
    order by e.created_at desc limit 100
  ) s;
$$;

-- Own ledger: backing count on my entries + the issues my pup backs (text only; still-shared only)
create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json; bk json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'shared', e.shared, 'ts', e.created_at,
           'media', e.media, 'topic', e.topic, 'place', e.place,
           'backs', (select count(*) from backs b where b.entry_id = e.id))
           order by e.created_at desc), '[]'::json)
    into es from entries e where e.tail = p_tail;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'ts', e.created_at, 'topic', e.topic, 'place', e.place,
           'pup', o.name, 'backed_at', b.created_at,
           'backs', (select count(*) from backs x where x.entry_id = e.id))
           order by b.created_at desc), '[]'::json)
    into bk from backs b join entries e on e.id = b.entry_id join ledgers o on o.tail = e.tail
    where b.tail = p_tail and e.shared;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es, 'backed', bk);
end $$;
