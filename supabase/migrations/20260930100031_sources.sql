-- Source map: per jurisdiction, the pages we watch. Found once (expensive search), checked daily (cheap).
create table if not exists sources (
  id           bigserial primary key,
  level        text not null check (level in ('city','province','federal')),
  region       text not null,
  parent       text not null default '',
  url          text not null,
  kind         text not null check (kind in ('elections','meetings','consultations','press','notices')),
  label        text,
  official     boolean not null default true,
  priority     int not null default 5,          -- 1 = check first
  last_checked timestamptz,
  last_changed timestamptz,
  last_hash    text,
  fails        int not null default 0,
  found_total  int not null default 0,
  created_at   timestamptz not null default now(),
  unique (level, region, parent, url)
);
create index if not exists sources_jur_idx on sources(level, region, parent);
alter table sources enable row level security;
grant all on sources to service_role;
grant usage, select on all sequences in schema public to service_role;
alter table jurisdictions add column if not exists sources_at timestamptz;   -- when the source list was last refreshed
alter table elections add column if not exists source_id bigint;
