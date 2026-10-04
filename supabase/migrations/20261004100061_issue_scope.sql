-- Who fixes this? Every issue has a level: local (city), state (state/province), national. Guessed from the words,
-- changeable by the person who posted it.
alter table entries add column if not exists scope text;
alter table entries drop constraint if exists entries_scope_check;
alter table entries add constraint entries_scope_check check (scope is null or scope in ('local', 'state', 'national'));

create or replace function vp_guess_scope(p_body text, p_topic text, p_source text default null) returns text language sql immutable as $$
  select case
    when p_source is not null then 'local'
    when coalesce(p_body, '') ~* '(inflation|immigra|federal|interest rate|mortgage rate|gas price|grocery price|carbon tax|income tax|gst|pension|\mcpp\M|\mei\M|tariff|border|military|defen[cs]e|foreign|economy|recession|national|parliament|congress|prime minister|president)' then 'national'
    when coalesce(p_body, '') ~* '(hospital|health ?care|wait time|doctor|family doctor|\mer\M|emergency room|nurse|school|teacher|class size|education|tuition|universit|college|highway|ferr(y|ies)|skytrain|rent control|tenan|landlord|\mrtb\M|minimum wage|icbc|car insurance|overdose|mental health|daycare|child ?care|provinc|state law|legislat)' then 'state'
    when coalesce(p_body, '') ~* '(\mrent\M|rents|housing cost|cost of housing|afford)' then 'state'
    when p_topic in ('health', 'education') then 'state'
    when p_topic = 'cost of living' then 'national'
    else 'local' end;
$$;

create or replace function vp_scope_default() returns trigger language plpgsql as $$
begin
  if new.scope is null then new.scope := vp_guess_scope(new.body, new.topic, new.source); end if;
  return new;
end $$;
drop trigger if exists entries_scope_default on entries;
create trigger entries_scope_default before insert on entries for each row execute function vp_scope_default();
update entries set scope = vp_guess_scope(body, topic, source) where scope is null;

create or replace function vp_set_scope(p_tail text, p_id uuid, p_scope text) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_scope not in ('local', 'state', 'national') then raise exception 'bad level'; end if;
  update entries set scope = p_scope where id = p_id and tail = p_tail;
end $$;
revoke all on function vp_set_scope(text, uuid, text) from public; grant execute on function vp_set_scope(text, uuid, text) to anon;

-- the board carries the level too
create or replace function vp_shared_board(p_place text default null)
returns json language sql security definer set search_path = public as $$
  with c as (select lower(trim(split_part(coalesce(p_place,''), ',', 1))) city),
  people as (select e.* from entries e, c where e.shared and e.source is null
               and (p_place is null or lower(trim(split_part(coalesce(e.place,''),',',1))) = c.city)
             order by e.created_at desc limit 100),
  official as (select * from (select e.*, row_number() over (partition by e.tail order by e.created_at desc) rn
                 from entries e, c where e.shared and e.source = 'city311'
                   and (p_place is null or lower(trim(split_part(coalesce(e.place,''),',',1))) = c.city)) q
               where rn <= (case when p_place is null then 6 else 40 end)),
  rows as (select id, tail, body, created_at, media, topic, place, spot, lat, lng, tags, fixed_at, source, scope from people
           union all select id, tail, body, created_at, media, topic, place, spot, lat, lng, tags, fixed_at, source, scope from official)
  select coalesce(json_agg(j order by (j->>'ts') desc), '[]'::json) from (
    select json_build_object('id', e.id, 'body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place, 'spot', e.spot, 'lat', e.lat, 'lng', e.lng, 'tags', e.tags,
                             'source', e.source, 'scope', e.scope,
                             'backs', (select count(*) from backs b where b.entry_id = e.id),
                             'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
                             'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'),
                             'fixed_at', e.fixed_at) as j
    from rows e join ledgers l on l.tail = e.tail) s;
$$;
CREATE OR REPLACE FUNCTION public.vp_get_ledger(p_tail text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l ledgers%rowtype; es json; bk json; rx json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'shared', e.shared, 'ts', e.created_at,
           'media', e.media, 'topic', e.topic, 'place', e.place, 'fixed_at', e.fixed_at, 'scope', e.scope,
           'spot', e.spot, 'lat', e.lat, 'lng', e.lng,
           'backs', (select count(*) from backs b where b.entry_id = e.id),
           'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
           'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'),
           'rank', case when e.shared then vp_weekly_rank(e.id) end, 'tags', e.tags,
           'city', split_part(coalesce(e.place,''), ',', 1))
           order by e.created_at desc), '[]'::json)
    into es from entries e where e.tail = p_tail;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'ts', e.created_at, 'topic', e.topic, 'place', e.place,
           'media', e.media, 'pup', o.name, 'backed_at', b.created_at, 'fixed_at', e.fixed_at, 'scope', e.scope,
           'spot', e.spot, 'lat', e.lat, 'lng', e.lng,
           'backs', (select count(*) from backs x where x.entry_id = e.id),
           'still', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'still'),
           'fixedv', (select count(*) from reacts r where r.entry_id = e.id and r.kind = 'fixed'))
           order by b.created_at desc), '[]'::json)
    into bk from backs b join entries e on e.id = b.entry_id join ledgers o on o.tail = e.tail
    where b.tail = p_tail and e.shared;
  select coalesce(json_object_agg(entry_id, kind), '{}'::json) into rx from reacts where tail = p_tail;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es, 'backed', bk, 'reacts', rx);
end $function$;
CREATE OR REPLACE FUNCTION public.vp_get_view(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l ledgers%rowtype; es json; city text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{20}$' then return null; end if;
  select * into l from ledgers where view_token = p_token;
  if not found then return null; end if;
  select split_part(place, ',', 1) into city from entries
    where tail = l.tail and place is not null order by created_at desc limit 1;
  select coalesce(json_agg(json_build_object(
           'body', body, 'ts', created_at, 'media', media, 'topic', topic, 'spot', spot, 'fixed_at', fixed_at, 'scope', scope,
           'backs', (select count(*) from backs b where b.entry_id = entries.id))
           order by created_at desc), '[]'::json)
    into es from entries where tail = l.tail and (shared or l.view_all);
  return json_build_object('name', l.name, 'city', city, 'entries', es);
end $function$;
