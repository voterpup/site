-- "Show your candidate": separate READ-ONLY key per pup. Default shows only shared entries.
alter table ledgers add column if not exists view_token text;
alter table ledgers add column if not exists view_all boolean not null default false;
create unique index if not exists ledgers_view_token_uq on ledgers(view_token);

create or replace function vp_view_count(p_tail text)
returns int language sql security definer set search_path = public as $$
  select count(*)::int from entries e join ledgers l on l.tail = e.tail
  where e.tail = p_tail and (e.shared or l.view_all);
$$;

-- only the WRITE key (tail) can mint / read / rotate the view key
create or replace function vp_view_info(p_tail text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare t text; va boolean;
begin
  select view_token, view_all into t, va from ledgers where tail = p_tail;
  if not found then raise exception 'no such pup'; end if;
  if t is null then
    t := encode(gen_random_bytes(10), 'hex');
    update ledgers set view_token = t where tail = p_tail;
  end if;
  return json_build_object('token', t, 'view_all', va, 'count', vp_view_count(p_tail));
end $$;

create or replace function vp_rotate_view_token(p_tail text)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  update ledgers set view_token = encode(gen_random_bytes(10), 'hex') where tail = p_tail;
  return vp_view_info(p_tail);
end $$;

create or replace function vp_set_view_all(p_tail text, p_all boolean)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  update ledgers set view_all = coalesce(p_all, false) where tail = p_tail;
  if not found then raise exception 'no such pup'; end if;
  return vp_view_info(p_tail);
end $$;

-- the read-only view: pup name + city + filtered entries; nothing that leads back to the tail
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
           'body', body, 'ts', created_at, 'media', media, 'topic', topic)
           order by created_at desc), '[]'::json)
    into es from entries where tail = l.tail and (shared or l.view_all);
  return json_build_object('name', l.name, 'city', city, 'entries', es);
end $$;

grant execute on function vp_view_info(text) to anon;
grant execute on function vp_rotate_view_token(text) to anon;
grant execute on function vp_set_view_all(text, boolean) to anon;
grant execute on function vp_get_view(text) to anon;
