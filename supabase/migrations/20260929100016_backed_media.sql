-- Issues a pup backs now carry their media (signed by vp-read under the public, reviewed-only rule)
create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json; bk json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'shared', e.shared, 'ts', e.created_at,
           'media', e.media, 'topic', e.topic, 'place', e.place,
           'backs', (select count(*) from backs b where b.entry_id = e.id))
           order by e.created_at desc), '[]'::json)
    into es from entries e where e.tail = p_tail;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'ts', e.created_at, 'topic', e.topic, 'place', e.place,
           'media', e.media, 'pup', o.name, 'backed_at', b.created_at,
           'backs', (select count(*) from backs x where x.entry_id = e.id))
           order by b.created_at desc), '[]'::json)
    into bk from backs b join entries e on e.id = b.entry_id join ledgers o on o.tail = e.tail
    where b.tail = p_tail and e.shared;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es, 'backed', bk);
end $$;
