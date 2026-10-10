-- My spot: a shop can have a profile picture (logo or storefront), shown on its page and as its marker on the map.
alter table spots add column if not exists logo text;   -- storage path in the media bucket
notify pgrst, 'reload schema';
