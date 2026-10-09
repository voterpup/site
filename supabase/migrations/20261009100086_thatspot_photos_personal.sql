-- That spot v2: photos on memories, and a "personal" visibility (only me)
alter table spots add column if not exists photo text;   -- storage path in the media bucket, served by signed url
alter table spots drop constraint if exists spots_visibility_check;
alter table spots add constraint spots_visibility_check check (visibility in ('personal', 'link', 'public', 'hidden'));
create index if not exists spots_bound_idx on spots (bound_uid) where bound_uid is not null;
notify pgrst, 'reload schema';
