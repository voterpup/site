-- CONSOLIDATED PATCH (idempotent — safe to run once or many times, after base setup)
-- Adds: 80-bit tails · The Pack board · media (multi photo/video) support · storage bucket

alter table entries add column if not exists media jsonb not null default '[]'::jsonb;

create or replace function vp_create_ledger(p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare t text; n text;
begin
  n := trim(p_name);
  if length(n) < 1 or length(n) > 24 then raise exception 'name must be 1-24 chars'; end if;
  t := lower(regexp_replace(n, '[^a-zA-Z0-9]+', '-', 'g'))
       || '~' || encode(gen_random_bytes(10), 'hex');
  insert into ledgers(tail, name) values (t, n);
  return json_build_object('tail', t, 'name', n);
end $$;

create or replace function vp_add_entry(p_tail text, p_body text, p_shared boolean, p_media jsonb default '[]'::jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare b text; new_id uuid;
begin
  b := coalesce(trim(p_body), '');
  if length(b) > 500 then raise exception 'body must be at most 500 chars'; end if;
  if length(b) = 0 and jsonb_array_length(coalesce(p_media,'[]'::jsonb)) = 0 then
    raise exception 'say it or show it'; end if;
  if jsonb_array_length(coalesce(p_media,'[]'::jsonb)) > 4 then raise exception 'max 4 files'; end if;
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  insert into entries(tail, body, shared, media)
    values (p_tail, b, coalesce(p_shared,false), coalesce(p_media,'[]'::jsonb))
    returning id into new_id;
  return json_build_object('id', new_id);
end $$;

create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', id, 'body', body, 'shared', shared, 'ts', created_at, 'media', media)
           order by created_at desc), '[]'::json)
    into es from entries where tail = p_tail;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es);
end $$;

create or replace function vp_shared_board()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('body', e.body, 'ts', e.created_at, 'pup', l.name, 'media', e.media) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared order by e.created_at desc limit 100
  ) s;
$$;

grant execute on function vp_create_ledger(text) to anon;
grant execute on function vp_get_ledger(text) to anon;
grant execute on function vp_add_entry(text, text, boolean, jsonb) to anon;
grant execute on function vp_set_shared(text, uuid, boolean) to anon;
grant execute on function vp_shared_board() to anon;

-- media bucket: public read, 25MB/file, images+video only; uploads land at random uuid names
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media','media', true, 26214400,
  array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update set public=true, file_size_limit=26214400,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "anon upload media" on storage.objects;
create policy "anon upload media" on storage.objects
  for insert to anon with check (bucket_id = 'media');
