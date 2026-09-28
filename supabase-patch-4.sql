-- PATCH 4: per-issue location (city-level only) -> per-issue election tracking
alter table entries add column if not exists place text;

-- old 4-arg signature must go or PostgREST sees an ambiguous overload
drop function if exists vp_add_entry(text, text, boolean, jsonb);

create or replace function vp_add_entry(p_tail text, p_body text, p_shared boolean,
                                        p_media jsonb default '[]'::jsonb, p_place text default null)
returns json language plpgsql security definer set search_path = public as $$
declare b text; new_id uuid;
begin
  b := coalesce(trim(p_body), '');
  if length(b) > 500 then raise exception 'body must be at most 500 chars'; end if;
  if length(b) = 0 and jsonb_array_length(coalesce(p_media,'[]'::jsonb)) = 0 then
    raise exception 'say it or show it'; end if;
  if jsonb_array_length(coalesce(p_media,'[]'::jsonb)) > 4 then raise exception 'max 4 files'; end if;
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  insert into entries(tail, body, shared, media, place)
    values (p_tail, b, coalesce(p_shared,false), coalesce(p_media,'[]'::jsonb), nullif(trim(coalesce(p_place,'')),''))
    returning id into new_id;
  return json_build_object('id', new_id);
end $$;
grant execute on function vp_add_entry(text, text, boolean, jsonb, text) to anon;

create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', id, 'body', body, 'shared', shared, 'ts', created_at,
           'media', media, 'topic', topic, 'place', place)
           order by created_at desc), '[]'::json)
    into es from entries where tail = p_tail;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es);
end $$;

create or replace function vp_shared_board()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared order by e.created_at desc limit 100
  ) s;
$$;
grant execute on function vp_shared_board() to anon;
