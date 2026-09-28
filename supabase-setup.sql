-- VoterPup web pup backend — paste into Supabase SQL Editor and Run.
-- Model: capability links. Tables are LOCKED to the public; all access goes
-- through RPC functions that require knowing the unguessable tail.

create extension if not exists pgcrypto;

create table if not exists ledgers (
  tail text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  tail text not null references ledgers(tail) on delete cascade,
  body text not null,
  shared boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists entries_tail_idx on entries(tail, created_at desc);

-- RLS on, NO policies => anon key cannot touch tables directly.
alter table ledgers enable row level security;
alter table entries enable row level security;

-- Mint a pup: name -> slug~48bit-random tail
create or replace function vp_create_ledger(p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare t text; n text;
begin
  n := trim(p_name);
  if length(n) < 1 or length(n) > 24 then raise exception 'name must be 1-24 chars'; end if;
  t := lower(regexp_replace(n, '[^a-zA-Z0-9]+', '-', 'g'))
       || '~' || encode(gen_random_bytes(6), 'hex');
  insert into ledgers(tail, name) values (t, n);
  return json_build_object('tail', t, 'name', n);
end $$;

-- Fetch a ledger by tail (null if wrong tail — indistinguishable from missing)
create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', id, 'body', body, 'shared', shared, 'ts', created_at)
           order by created_at desc), '[]'::json)
    into es from entries where tail = p_tail;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es);
end $$;

create or replace function vp_add_entry(p_tail text, p_body text, p_shared boolean)
returns json language plpgsql security definer set search_path = public as $$
declare b text; new_id uuid;
begin
  b := trim(p_body);
  if length(b) < 1 or length(b) > 500 then raise exception 'body must be 1-500 chars'; end if;
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  insert into entries(tail, body, shared) values (p_tail, b, coalesce(p_shared,false))
    returning id into new_id;
  return json_build_object('id', new_id);
end $$;

create or replace function vp_set_shared(p_tail text, p_id uuid, p_shared boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update entries set shared = p_shared where id = p_id and tail = p_tail;
end $$;

revoke all on ledgers, entries from anon, authenticated;
grant execute on function vp_create_ledger(text) to anon;
grant execute on function vp_get_ledger(text) to anon;
grant execute on function vp_add_entry(text, text, boolean) to anon;
grant execute on function vp_set_shared(text, uuid, boolean) to anon;
