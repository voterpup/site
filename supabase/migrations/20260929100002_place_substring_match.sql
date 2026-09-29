-- Locality matching: substring containment instead of exact first-segment equality
create or replace function vp_shared_board(p_place text default null)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('body', e.body, 'ts', e.created_at, 'pup', l.name,
                             'media', e.media, 'topic', e.topic, 'place', e.place) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared
      and (p_place is null
           or lower(coalesce(e.place,'')) like '%' || lower(split_part(p_place,',',1)) || '%')
    order by e.created_at desc limit 100
  ) s;
$$;
