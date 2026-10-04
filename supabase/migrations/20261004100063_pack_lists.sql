-- A pack's own list: members add issues, everyone votes (one vote each per item), the ranked list can be shared
-- read-only by link (no pup names, no chat, no photos on the public page).
create table if not exists pack_items (id uuid primary key default gen_random_uuid(), pack_id uuid not null references packs(id) on delete cascade,
  tail text not null references ledgers(tail) on delete cascade, body text not null check (char_length(body) between 2 and 140), topic text,
  entry_id uuid, created_at timestamptz not null default now());
create index if not exists pack_items_pack on pack_items (pack_id);
create table if not exists pack_votes (item_id uuid not null references pack_items(id) on delete cascade, tail text not null references ledgers(tail) on delete cascade,
  created_at timestamptz not null default now(), primary key (item_id, tail));
alter table packs add column if not exists share_id text unique;
alter table pack_items enable row level security; alter table pack_votes enable row level security;
grant select, insert, update, delete on pack_items, pack_votes to service_role;

create or replace function vp_pack_items(p_tail text, p_pack uuid) returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not vp_is_member(p_tail, p_pack) then raise exception 'Not in this pack yet.'; end if;
  return (select coalesce(json_agg(x order by x.votes desc, x.created_at), '[]'::json) from (
    select i.id, i.body, i.topic, i.created_at, i.tail = p_tail mine, l.name who,
      (select count(*) from pack_votes v where v.item_id = i.id) votes, exists (select 1 from pack_votes v where v.item_id = i.id and v.tail = p_tail) voted
    from pack_items i join ledgers l on l.tail = i.tail where i.pack_id = p_pack) x);
end $$;

create or replace function vp_pack_vote(p_tail text, p_item uuid) returns int language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  select pack_id into pid from pack_items where id = p_item;
  if pid is null or not vp_is_member(p_tail, pid) then raise exception 'not found'; end if;
  if exists (select 1 from pack_votes where item_id = p_item and tail = p_tail) then delete from pack_votes where item_id = p_item and tail = p_tail;
  else insert into pack_votes(item_id, tail) values (p_item, p_tail); end if;
  return (select count(*) from pack_votes where item_id = p_item);
end $$;

create or replace function vp_pack_item_remove(p_tail text, p_item uuid) returns void language plpgsql security definer set search_path = public as $$
begin   -- whoever added it, or the pack owner
  delete from pack_items i using packs p where i.id = p_item and p.id = i.pack_id and (i.tail = p_tail or p.owner_tail = p_tail);
end $$;

create or replace function vp_pack_share(p_tail text, p_pack uuid) returns text language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if not vp_is_member(p_tail, p_pack) then raise exception 'Not in this pack yet.'; end if;
  select share_id into s from packs where id = p_pack;
  if s is null then s := substr(md5(gen_random_uuid()::text), 1, 10); update packs set share_id = s where id = p_pack; end if;
  return s;
end $$;

create or replace function vp_pack_public_list(p_share text) returns json language sql stable security definer set search_path = public as $$
  select json_build_object('name', p.name, 'members', (select count(*) from pack_members m where m.pack_id = p.id and m.status = 'active'),
    'items', (select coalesce(json_agg(x order by x.votes desc, x.created_at), '[]'::json) from (
      select i.body, i.topic, i.created_at, (select count(*) from pack_votes v where v.item_id = i.id) votes from pack_items i where i.pack_id = p.id) x))
  from packs p where p.share_id = p_share and p_share is not null;
$$;

do $$ declare f text; begin
  foreach f in array array['vp_pack_items(text,uuid)','vp_pack_vote(text,uuid)','vp_pack_item_remove(text,uuid)','vp_pack_share(text,uuid)','vp_pack_public_list(text)'] loop
    execute 'revoke all on function ' || f || ' from public'; execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $$;
