-- Memory wall: approval queue, photo consent, owner removal.
-- 1. A shop can ask to approve posts before they show ("Approve posts first", a switch in the owner panel).
alter table spots add column if not exists approve_first boolean not null default false;      -- on the shop's own row
-- 2. A memory left at such a shop waits for the owner's OK; guests never see it until then (the maker and the owner do).
alter table spots add column if not exists awaiting_owner boolean not null default false;     -- on the memory's row
-- 3. When a photo is posted on a shop's wall, the poster confirms everyone pictured is okay with it (a parent or guardian for a child). We keep when.
alter table spots add column if not exists photo_consent_at timestamptz;
notify pgrst, 'reload schema';
