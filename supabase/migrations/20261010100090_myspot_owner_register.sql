-- My spot: an owner can claim a shop; the founder verifies and approves; the owner then sees their numbers and manages their wall.
alter table spots add column if not exists owner_uid uuid;
alter table spots add column if not exists owner_status text check (owner_status in ('pending', 'approved', 'rejected'));
alter table spots add column if not exists claim_note text;      -- what the claimant wrote (name, role, a line about the shop)
alter table spots add column if not exists hidden_by_owner boolean not null default false;   -- a memory the shop owner hid from their wall
notify pgrst, 'reload schema';
