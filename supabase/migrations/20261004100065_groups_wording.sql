-- "Packs" are called "Groups" in the app now: user-facing error messages follow.
do $$ declare f record; src text; begin
  for f in select p.oid, pg_get_functiondef(p.oid) d from pg_proc p where p.proname in ('vp_pack_create','vp_pack_code','vp_pack_new_code_now','vp_pack_join','vp_pack_decide','vp_pack_items','vp_pack_share') loop
    src := replace(replace(replace(replace(replace(f.d, 'A pup can be in up to 5 packs', 'A pup can be in up to 5 groups'), 'Give your pack a name', 'Give your group a name'),
      'That pack is full (12 pups).', 'That group is full (12 pups).'), 'Only the pack owner', 'Only the group owner'), 'Not in this pack yet.', 'Not in this group yet.');
    src := replace(src, 'That is a lot of new packs for one day.', 'That is a lot of new groups for one day.');
    execute src;
  end loop;
end $$;
