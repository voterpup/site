-- My spot: nobody claims a shop. We create the shop's spot; its QR lets anyone standing there post to it. Owners get visits and analytics by email.
alter table spots add column if not exists place_code text;      -- a memory posted "at" a shop carries the shop's code
alter table spots add column if not exists owner_email text;     -- on a place: where the weekly numbers go
alter table spots add column if not exists owner_note text;      -- on a place: what we know about the contact (never shown)
create index if not exists spots_place_code_idx on spots (place_code) where place_code is not null;
notify pgrst, 'reload schema';
