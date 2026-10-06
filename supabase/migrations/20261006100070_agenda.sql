-- The Agenda: "which should the city fix first?" picks between two issues. Every pick moves both issues' city rating
-- (Elo, K=24); the city's agenda is the ranking; each pup's own agenda is computed on the phone from its own picks.
create table if not exists agenda_items (city text not null, key text not null, label text not null, kind text not null default 'local',
  topic text, entry_id uuid, rating real not null default 1500, n int not null default 0, wins int not null default 0,
  updated_at timestamptz not null default now(), primary key (city, key));
create table if not exists agenda_picks (id bigserial primary key, tail text not null references ledgers(tail) on delete cascade, city text not null,
  winner text not null, loser text not null, created_at timestamptz not null default now());
create index if not exists agenda_picks_pair on agenda_picks (city, winner, loser);
create index if not exists agenda_picks_tail on agenda_picks (tail, created_at desc);
alter table agenda_items enable row level security; alter table agenda_picks enable row level security;
grant select, insert, update, delete on agenda_items, agenda_picks to service_role; grant usage, select on sequence agenda_picks_id_seq to service_role;

create or replace function vp_pick(p_tail text, p_city text, p_w jsonb, p_l jsonb) returns json language plpgsql security definer set search_path = public as $$
declare c text := lower(left(trim(coalesce(p_city, '')), 60)); wk text := left(p_w->>'key', 80); lk text := left(p_l->>'key', 80);
        rw real; rl real; ew real; same int; other int; tot int; ranks json;
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if c = '' or wk is null or lk is null or wk = lk then raise exception 'bad pick'; end if;
  if (select count(*) from agenda_picks where tail = p_tail and created_at > now() - interval '1 day') >= 80 then raise exception 'That is plenty of picks for today. Come back tomorrow 🐾'; end if;
  insert into agenda_items(city, key, label, kind, topic, entry_id) values
    (c, wk, left(coalesce(p_w->>'label', wk), 120), left(coalesce(p_w->>'kind', 'local'), 12), left(p_w->>'topic', 30), nullif(p_w->>'entry', '')::uuid),
    (c, lk, left(coalesce(p_l->>'label', lk), 120), left(coalesce(p_l->>'kind', 'local'), 12), left(p_l->>'topic', 30), nullif(p_l->>'entry', '')::uuid)
  on conflict (city, key) do update set label = excluded.label;
  -- the same pup choosing the same pair again within a day only counts once
  if not exists (select 1 from agenda_picks where tail = p_tail and city = c and ((winner = wk and loser = lk) or (winner = lk and loser = wk)) and created_at > now() - interval '1 day') then
    select rating into rw from agenda_items where city = c and key = wk; select rating into rl from agenda_items where city = c and key = lk;
    ew := 1 / (1 + power(10, (rl - rw) / 400));
    update agenda_items set rating = rating + 24 * (1 - ew), n = n + 1, wins = wins + 1, updated_at = now() where city = c and key = wk;
    update agenda_items set rating = rating - 24 * (1 - ew), n = n + 1, updated_at = now() where city = c and key = lk;
    insert into agenda_picks(tail, city, winner, loser) values (p_tail, c, wk, lk);
  end if;
  select count(*) into same from agenda_picks where city = c and winner = wk and loser = lk;
  select count(*) into other from agenda_picks where city = c and winner = lk and loser = wk;
  select count(distinct tail) into tot from agenda_picks where city = c;
  select json_object_agg(key, rk) into ranks from (select key, rank() over (order by rating desc) rk from agenda_items where city = c) x where key in (wk, lk);
  return json_build_object('same', same, 'other', other, 'pickers', tot, 'rank_w', ranks->>wk, 'rank_l', ranks->>lk);
end $$;

create or replace function vp_city_agenda(p_city text, p_n int default 10) returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'items', coalesce((select json_agg(x) from (select key, label, kind, topic, entry_id, round(rating) rating, n, wins from agenda_items
                       where city = lower(p_city) and n > 0 order by rating desc limit greatest(1, least(p_n, 50))) x), '[]'::json),
    'ratings', coalesce((select json_object_agg(key, round(rating)) from agenda_items where city = lower(p_city)), '{}'::json),
    'pickers', (select count(distinct tail) from agenda_picks where city = lower(p_city)),
    'picks', (select count(*) from agenda_picks where city = lower(p_city)));
$$;

create or replace function vp_my_picks(p_tail text, p_city text) returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('w', p.winner, 'l', p.loser, 'ts', p.created_at,
           'wl', (select label from agenda_items i where i.city = p.city and i.key = p.winner), 'll', (select label from agenda_items i where i.city = p.city and i.key = p.loser),
           'wk', (select kind from agenda_items i where i.city = p.city and i.key = p.winner), 'lk', (select kind from agenda_items i where i.city = p.city and i.key = p.loser),
           'wt', (select topic from agenda_items i where i.city = p.city and i.key = p.winner), 'lt', (select topic from agenda_items i where i.city = p.city and i.key = p.loser)) order by p.created_at), '[]'::json)
  from (select * from agenda_picks where tail = p_tail and city = lower(p_city) order by created_at desc limit 300) p;
$$;

do $$ declare f text; begin
  foreach f in array array['vp_pick(text,text,jsonb,jsonb)','vp_city_agenda(text,int)','vp_my_picks(text,text)'] loop
    execute 'revoke all on function ' || f || ' from public'; execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $$;

-- the tracker learns the new event
do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''snap'',''emoji'')', '''snap'',''emoji'',''pick'')');
  execute d;
end $$;
