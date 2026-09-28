-- PATCH 3: elections + vote timer + topic column (idempotent)
alter table entries add column if not exists topic text;

create table if not exists elections (
  id serial primary key,
  name text not null,
  level text not null,          -- city | province | federal | council
  region text not null,         -- matched against user's detected city/region, lowercase
  vote_date date not null
);
alter table elections enable row level security;

insert into elections (name, level, region, vote_date)
select * from (values
  ('Vancouver municipal election', 'city', 'vancouver', date '2026-10-17'),
  ('BC provincial election', 'province', 'british columbia', date '2028-10-21'),
  ('Canadian federal election', 'federal', 'canada', date '2029-10-15')
) v(name, level, region, vote_date)
where not exists (select 1 from elections);

-- next relevant election for a detected place string (e.g. "Vancouver, British Columbia, Canada")
create or replace function vp_find_election(p_place text)
returns json language sql security definer set search_path = public as $$
  select json_build_object('name', name, 'level', level, 'vote_date', vote_date,
           'days', (vote_date - current_date))
  from elections
  where vote_date >= current_date
    and lower(coalesce(p_place,'')) like '%' || region || '%'
  order by vote_date asc limit 1;
$$;
grant execute on function vp_find_election(text) to anon;

-- expose topic in reads
create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', id, 'body', body, 'shared', shared, 'ts', created_at, 'media', media, 'topic', topic)
           order by created_at desc), '[]'::json)
    into es from entries where tail = p_tail;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es);
end $$;

create or replace function vp_shared_board()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared order by e.created_at desc limit 100
  ) s;
$$;
grant execute on function vp_shared_board() to anon;
