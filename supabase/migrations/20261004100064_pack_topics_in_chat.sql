-- Topics live in the chat: a topic is a message pointing at a pack item. Invite links peek at the pack before joining.
alter table pack_messages add column if not exists item_id uuid references pack_items(id) on delete cascade;
create or replace function vp_pack_peek(p_code text) returns json language sql stable security definer set search_path = public as $$
  select json_build_object('name', p.name, 'owner', l.name, 'members', (select count(*) from pack_members m where m.pack_id = p.id and m.status = 'active'), 'expires_at', c.expires_at)
  from pack_codes c join packs p on p.id = c.pack_id join ledgers l on l.tail = p.owner_tail
  where c.code = vp_pack_norm(p_code) and c.expires_at > now();
$$;
revoke all on function vp_pack_peek(text) from public; grant execute on function vp_pack_peek(text) to anon;
