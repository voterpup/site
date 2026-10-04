-- Packs: small friend groups. Join with a fun one-hour code ("8 squeaky bones"), the owner lets people in,
-- members chat (text checked before it is shown; small photos and videos). No accounts, no names.
create table if not exists packs (id uuid primary key default gen_random_uuid(), name text not null check (char_length(name) between 1 and 40),
  owner_tail text not null references ledgers(tail) on delete cascade, created_at timestamptz not null default now());
create table if not exists pack_members (pack_id uuid not null references packs(id) on delete cascade, tail text not null references ledgers(tail) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')), status text not null default 'pending' check (status in ('pending', 'active')),
  joined_at timestamptz not null default now(), last_read timestamptz, last_push timestamptz, primary key (pack_id, tail));
create table if not exists pack_codes (code text primary key, pack_id uuid not null references packs(id) on delete cascade, expires_at timestamptz not null);
create table if not exists pack_messages (id uuid primary key default gen_random_uuid(), pack_id uuid not null references packs(id) on delete cascade,
  tail text not null references ledgers(tail) on delete cascade, body text check (char_length(body) <= 500), media jsonb not null default '[]'::jsonb,
  mod text not null default 'ok' check (mod in ('ok', 'blocked')), created_at timestamptz not null default now());
create index if not exists pack_messages_pack on pack_messages (pack_id, created_at desc);
create table if not exists pack_reports (message_id uuid not null references pack_messages(id) on delete cascade, tail text not null, created_at timestamptz not null default now(), primary key (message_id, tail));
alter table packs enable row level security; alter table pack_members enable row level security; alter table pack_codes enable row level security;
alter table pack_messages enable row level security; alter table pack_reports enable row level security;
grant select, insert, update, delete on packs, pack_members, pack_codes, pack_messages, pack_reports to service_role;

-- a friendly, safe code: a number and two dog words
create or replace function vp_pack_new_code(p_pack uuid) returns text language plpgsql security definer set search_path = public as $$
declare adj text[] := array['squeaky','muddy','fluffy','sleepy','waggy','bouncy','happy','sunny','zoomy','snuggly','sniffy','crunchy','jolly','speedy','chewy','cozy','sparkly','giggly'];
        noun text[] := array['bones','paws','tails','sticks','tennis balls','biscuits','puddles','leashes','frisbees','collars','naps','treats','walks','chew toys','acorns','squirrels','socks','sniffs'];
        c text; i int := 0;
begin
  delete from pack_codes where expires_at < now();
  loop
    c := (2 + floor(random() * 11))::int || ' ' || adj[1 + floor(random() * array_length(adj, 1))::int] || ' ' || noun[1 + floor(random() * array_length(noun, 1))::int];
    exit when not exists (select 1 from pack_codes where code = c); i := i + 1; exit when i > 30;
  end loop;
  insert into pack_codes(code, pack_id, expires_at) values (c, p_pack, now() + interval '1 hour');
  return c;
end $$;
create or replace function vp_pack_norm(p text) returns text language sql immutable as $$ select trim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g')) $$;
create or replace function vp_is_member(p_tail text, p_pack uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from pack_members where pack_id = p_pack and tail = p_tail and status = 'active') $$;

create or replace function vp_pack_create(p_tail text, p_name text) returns json language plpgsql security definer set search_path = public as $$
declare pid uuid; n text := left(trim(coalesce(p_name, '')), 40);
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if n = '' then raise exception 'Give your pack a name'; end if;
  if (select count(*) from pack_members where tail = p_tail) >= 5 then raise exception 'A pup can be in up to 5 packs'; end if;
  perform vp_limit('pack_new', vp_conn(), 10, interval '1 day', 'That is a lot of new packs for one day. Try tomorrow.');
  insert into packs(name, owner_tail) values (n, p_tail) returning id into pid;
  insert into pack_members(pack_id, tail, role, status) values (pid, p_tail, 'owner', 'active');
  return json_build_object('id', pid, 'name', n, 'code', vp_pack_new_code(pid));
end $$;

create or replace function vp_pack_code(p_tail text, p_pack uuid) returns json language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if not exists (select 1 from packs where id = p_pack and owner_tail = p_tail) then raise exception 'Only the pack owner can make codes'; end if;
  select code, expires_at into c from pack_codes where pack_id = p_pack and expires_at > now() + interval '5 minutes' order by expires_at desc limit 1;
  if found then return json_build_object('code', c.code, 'expires_at', c.expires_at); end if;
  return (select json_build_object('code', code, 'expires_at', expires_at) from pack_codes where code = vp_pack_new_code(p_pack));
end $$;
create or replace function vp_pack_new_code_now(p_tail text, p_pack uuid) returns json language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from packs where id = p_pack and owner_tail = p_tail) then raise exception 'Only the pack owner can make codes'; end if;
  delete from pack_codes where pack_id = p_pack;   -- the old code stops working; members stay
  return (select json_build_object('code', code, 'expires_at', expires_at) from pack_codes where code = vp_pack_new_code(p_pack));
end $$;

create or replace function vp_pack_join(p_tail text, p_code text) returns json language plpgsql security definer set search_path = public as $$
declare pc record; p record;
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  perform vp_limit('pack_join', vp_conn(), 20, interval '1 hour', 'Too many tries. Wait a little and check the code.');
  select * into pc from pack_codes where code = vp_pack_norm(p_code) and expires_at > now();
  if not found then raise exception 'That code didn''t work. Codes last one hour: ask for a fresh one.'; end if;
  select * into p from packs where id = pc.pack_id;
  if exists (select 1 from pack_members where pack_id = p.id and tail = p_tail) then
    return json_build_object('id', p.id, 'name', p.name, 'status', (select status from pack_members where pack_id = p.id and tail = p_tail)); end if;
  if (select count(*) from pack_members where pack_id = p.id) >= 12 then raise exception 'That pack is full (12 pups).'; end if;
  if (select count(*) from pack_members where tail = p_tail) >= 5 then raise exception 'A pup can be in up to 5 packs'; end if;
  insert into pack_members(pack_id, tail, role, status) values (p.id, p_tail, 'member', 'pending');
  return json_build_object('id', p.id, 'name', p.name, 'status', 'pending');
end $$;

create or replace function vp_pack_decide(p_tail text, p_pack uuid, p_member text, p_ok boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from packs where id = p_pack and owner_tail = p_tail) then raise exception 'Only the pack owner can do that'; end if;
  if p_member = p_tail then raise exception 'That''s you'; end if;
  if p_ok then update pack_members set status = 'active', joined_at = now() where pack_id = p_pack and tail = p_member;
  else delete from pack_members where pack_id = p_pack and tail = p_member; end if;   -- deny, or remove
end $$;
create or replace function vp_pack_leave(p_tail text, p_pack uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from packs where id = p_pack and owner_tail = p_tail) then delete from packs where id = p_pack;   -- the owner leaving closes the pack
  else delete from pack_members where pack_id = p_pack and tail = p_tail; end if;
end $$;

create or replace function vp_my_packs(p_tail text) returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'owner', p.owner_tail = p_tail, 'status', m.status,
    'members', (select json_agg(json_build_object('tail', case when p.owner_tail = p_tail or x.tail = p_tail then x.tail end, 'name', l.name, 'role', x.role, 'status', x.status, 'me', x.tail = p_tail) order by x.joined_at)
                from pack_members x join ledgers l on l.tail = x.tail where x.pack_id = p.id and (x.status = 'active' or p.owner_tail = p_tail or x.tail = p_tail)),
    'unread', (select count(*) from pack_messages g where g.pack_id = p.id and g.created_at > coalesce(m.last_read, m.joined_at) and g.tail <> p_tail and g.mod = 'ok' and m.status = 'active'),
    'last', (select json_build_object('body', left(g.body, 60), 'ts', g.created_at, 'who', l2.name) from pack_messages g join ledgers l2 on l2.tail = g.tail where g.pack_id = p.id and g.mod = 'ok' and m.status = 'active' order by g.created_at desc limit 1)
  ) order by p.created_at desc), '[]'::json)
  from pack_members m join packs p on p.id = m.pack_id where m.tail = p_tail;
$$;

create or replace function vp_pack_report(p_tail text, p_msg uuid) returns void language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  select pack_id into pid from pack_messages where id = p_msg;
  if pid is null or not vp_is_member(p_tail, pid) then raise exception 'not found'; end if;
  insert into pack_reports(message_id, tail) values (p_msg, p_tail) on conflict do nothing;
  update pack_messages set mod = 'blocked' where id = p_msg and (select count(*) from pack_reports where message_id = p_msg) >= 2;   -- two reports hide it
end $$;

do $$ declare f text; begin
  foreach f in array array['vp_pack_create(text,text)','vp_pack_code(text,uuid)','vp_pack_new_code_now(text,uuid)','vp_pack_join(text,text)','vp_pack_decide(text,uuid,text,boolean)','vp_pack_leave(text,uuid)','vp_my_packs(text)','vp_pack_report(text,uuid)'] loop
    execute 'revoke all on function ' || f || ' from public'; execute 'grant execute on function ' || f || ' to anon';
  end loop;
  execute 'revoke all on function vp_pack_new_code(uuid) from public, anon, authenticated';
end $$;
