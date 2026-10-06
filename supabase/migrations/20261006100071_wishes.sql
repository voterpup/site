-- The Wish Wall (prototype): anonymous one-line local wishes ("I wish…"), 🐾 to agree. Only pups on the proto list see it.
create table if not exists proto_emails (email text primary key);
insert into proto_emails values ('adzala.13@gmail.com') on conflict do nothing;
create table if not exists wishes (id uuid primary key default gen_random_uuid(), tail text references ledgers(tail) on delete cascade, body text not null check (char_length(body) between 3 and 140),
  lat double precision, lng double precision, city text, example boolean not null default false, mod text not null default 'ok' check (mod in ('ok','blocked')), created_at timestamptz not null default now());
create index if not exists wishes_city on wishes (city, created_at desc);
create table if not exists wish_paws (wish_id uuid not null references wishes(id) on delete cascade, tail text not null references ledgers(tail) on delete cascade, created_at timestamptz not null default now(), primary key (wish_id, tail));
create table if not exists wish_reports (wish_id uuid not null references wishes(id) on delete cascade, tail text not null, primary key (wish_id, tail));
alter table proto_emails enable row level security; alter table wishes enable row level security; alter table wish_paws enable row level security; alter table wish_reports enable row level security;
grant select, insert, update, delete on proto_emails, wishes, wish_paws, wish_reports to service_role;

create or replace function vp_is_proto(p_tail text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from ledger_owners o join auth.users u on u.id = o.user_id join proto_emails p on p.email = lower(u.email) where o.tail = p_tail);
$$;

-- wishes near a point (or a whole city), with paw counts; positions come back rounded so no wish pins a doorstep
create or replace function vp_wishes(p_tail text, p_city text, p_lat double precision, p_lng double precision, p_km double precision default 2, p_sort text default 'top') returns json language plpgsql stable security definer set search_path = public as $$
declare proto boolean := vp_is_proto(p_tail);
begin
  return (select coalesce(json_agg(x), '[]'::json) from (
    select w.id, w.body, w.example, w.created_at ts, round(w.lat::numeric, 3) lat, round(w.lng::numeric, 3) lng, w.tail = p_tail mine,
      (select count(*) from wish_paws p where p.wish_id = w.id) paws, exists (select 1 from wish_paws p where p.wish_id = w.id and p.tail = p_tail) pawed,
      case when p_lat is null or w.lat is null then null else round((sqrt(power((w.lng - p_lng) * cos(radians((w.lat + p_lat) / 2)), 2) + power(w.lat - p_lat, 2)) * 111.2)::numeric, 1) end km
    from wishes w
    where w.mod = 'ok' and (not w.example or proto) and lower(w.city) = lower(p_city)
      and (p_lat is null or p_km >= 100 or w.lat is null or sqrt(power((w.lng - p_lng) * cos(radians((w.lat + p_lat) / 2)), 2) + power(w.lat - p_lat, 2)) * 111.2 <= p_km)
    order by case when p_sort = 'new' then extract(epoch from w.created_at) else 0 end desc,
             (select count(*) from wish_paws p where p.wish_id = w.id and p.created_at > now() - interval '7 days') desc, w.created_at desc
    limit 80) x);
end $$;

create or replace function vp_wish_paw(p_tail text, p_id uuid) returns int language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if exists (select 1 from wish_paws where wish_id = p_id and tail = p_tail) then delete from wish_paws where wish_id = p_id and tail = p_tail;
  else insert into wish_paws(wish_id, tail) values (p_id, p_tail); end if;
  return (select count(*) from wish_paws where wish_id = p_id);
end $$;

create or replace function vp_wish_report(p_tail text, p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into wish_reports(wish_id, tail) values (p_id, p_tail) on conflict do nothing;
  update wishes set mod = 'blocked' where id = p_id and (select count(*) from wish_reports where wish_id = p_id) >= 2;
end $$;

do $$ declare f text; begin
  foreach f in array array['vp_is_proto(text)','vp_wishes(text,text,double precision,double precision,double precision,text)','vp_wish_paw(text,uuid)','vp_wish_report(text,uuid)'] loop
    execute 'revoke all on function ' || f || ' from public'; execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $$;

-- examples, visible only to prototype testers, clearly tagged as examples in the app
insert into wishes (body, lat, lng, city, example) values
 ('I wish the bus didn''t leave the second I reach the stop', 49.2632, -123.1009, 'vancouver', true),
 ('I wish rent didn''t eat half my paycheque', 49.2617, -123.1140, 'vancouver', true),
 ('I wish there was a bakery open past 6 pm', 49.2660, -123.1005, 'vancouver', true),
 ('I wish the street light on my block worked', 49.2601, -123.1087, 'vancouver', true),
 ('I wish someone fixed the pothole that eats my bike tire', 49.2586, -123.1150, 'vancouver', true),
 ('I wish the dog park had lights in winter', 49.2648, -123.0961, 'vancouver', true),
 ('I wish my doctor could see me this month', 49.2689, -123.1032, 'vancouver', true),
 ('I wish there were more benches for my grandma', 49.2575, -123.1012, 'vancouver', true),
 ('I wish the guy on 12th stopped practising trumpet at 6 am', 49.2609, -123.1064, 'vancouver', true),
 ('I wish Main Street had more trees', 49.2624, -123.1006, 'vancouver', true)
on conflict do nothing;
