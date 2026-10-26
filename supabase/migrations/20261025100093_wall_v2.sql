-- Memory wall v2.
-- 1. Visitors' coordinates are never stored: an open is a row with a time and (if signed in) who, nothing about where they stood.
--    The privacy page says "never keeps a history of where you have been"; this makes it true in the schema, not only in the code.
alter table spot_finds drop column if exists lat;
alter table spot_finds drop column if exists lng;
-- 2. Owners can pin a memory to the top of their wall.
alter table spots add column if not exists pinned_by_owner boolean not null default false;
-- 3. Hearts on memories: one per person (account id, or a random device number for visitors without an account), stored as a count.
create table if not exists spot_hearts (
  spot_id bigint not null references spots(id) on delete cascade,
  who text not null,                      -- 'u:<uid>' or 'd:<sha256 of the device number>'
  created_at timestamptz not null default now(),
  primary key (spot_id, who)
);
alter table spot_hearts enable row level security;
grant all on table spot_hearts to service_role;
revoke all on table spot_hearts from anon, authenticated;
-- 4. The owners' weekly report gets a real unsubscribe (one row per owner email and shop).
alter table spot_subs drop constraint if exists spot_subs_kind_check;
alter table spot_subs add constraint spot_subs_kind_check check (kind in ('my_memory', 'place_new', 'owner_weekly'));
notify pgrst, 'reload schema';
