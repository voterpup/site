-- That spot (voterpup.com/thatspot): leave something at a place; it opens only for someone standing there.
-- Makers are Google-signed-in profiles; finding a public drop needs no account. All access goes through the thatspot edge function.
create table if not exists spot_profiles (
  uid uuid primary key,
  name text not null,
  photo text,
  created_at timestamptz not null default now()
);
create table if not exists spots (
  id bigserial primary key,
  code text not null unique,
  maker uuid not null references spot_profiles(uid),
  lat double precision not null,
  lng double precision not null,
  radius_m int not null default 40,
  body text not null,
  clue text,
  visibility text not null default 'link' check (visibility in ('link', 'public', 'hidden')),
  bound_uid uuid,                  -- a link drop binds to the first signed-in finder
  opens_at timestamptz,
  created_at timestamptz not null default now(),
  src text
);
create index if not exists spots_maker_idx on spots (maker);
create index if not exists spots_geo_idx on spots (lat, lng) where visibility = 'public';
create table if not exists spot_finds (
  id bigserial primary key,
  spot_id bigint not null references spots(id) on delete cascade,
  finder_uid uuid,
  finder_name text,
  note text,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);
create index if not exists spot_finds_spot_idx on spot_finds (spot_id);
create index if not exists spot_finds_finder_idx on spot_finds (finder_uid);
alter table spot_profiles enable row level security;
alter table spots enable row level security;
alter table spot_finds enable row level security;
grant all on table spot_profiles, spots, spot_finds to service_role;
grant usage, select, update on sequence spots_id_seq, spot_finds_id_seq to service_role;
revoke all on table spot_profiles, spots, spot_finds from anon, authenticated;

do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''v2'',''seal'')', '''v2'',''seal'',''spot'')');
  if d not like '%''spot''%' then raise exception 'track patch'; end if; execute d;
end $$;
notify pgrst, 'reload schema';
