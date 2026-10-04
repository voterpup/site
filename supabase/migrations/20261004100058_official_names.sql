update ledgers set name = initcap(replace(replace(tail, 'official-', ''), '-~311', '')) where false;
update ledgers set name = initcap(replace(split_part(replace(tail, 'official-', ''), '~', 1), '-', ' ')) || ' 3-1-1' where tail like 'official-%';
create or replace function vp_official_backfill(p_per_city int default 40) returns json language plpgsql security definer set search_path = public as $$
declare n_in int := 0; n_out int := 0; c record; k int;
begin
  for c in select distinct city from city_pins loop
    insert into ledgers(tail, name) values (vp_official_tail(c.city), initcap(c.city) || ' 3-1-1') on conflict (tail) do nothing;
    insert into entries(tail, body, shared, media, topic, topic_src, place, lat, lng, spot, created_at, source, ext_id)
    select vp_official_tail(c.city), left(regexp_replace(rtype, ' Case$', ''), 200), true, '[]'::jsonb, topic, 'city',
           initcap(c.city), lat, lng, left(area, 80), ts, 'city311', id
    from (select * from city_pins p where p.city = c.city and p.lat is not null order by ts desc limit p_per_city) latest
    on conflict do nothing;
    get diagnostics k = row_count; n_in := n_in + k;
  end loop;
  delete from entries e where e.source = 'city311' and (
      e.created_at < now() - interval '45 days'
      or (e.created_at < now() - interval '14 days' and not exists (select 1 from backs b where b.entry_id = e.id) and not exists (select 1 from emoji_reacts r where r.entry_id = e.id)));
  get diagnostics n_out = row_count;
  return json_build_object('added', n_in, 'removed', n_out);
end $$;
revoke all on function vp_official_backfill(int) from public, anon, authenticated;
grant execute on function vp_official_backfill(int) to service_role;
