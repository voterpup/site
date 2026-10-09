-- My spot: a shop can claim its spot. A "place" is a public memory that carries the shop's name; its link and QR attach to the shop.
alter table spots add column if not exists kind text not null default 'memory' check (kind in ('memory', 'place'));
alter table spots add column if not exists place_name text;
create index if not exists spots_place_idx on spots (kind) where kind = 'place';
notify pgrst, 'reload schema';
