-- Share cards: a public PNG per shared issue (drawn on the phone at share time), read by chat apps for link previews.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('cards', 'cards', true, 600000, array['image/png','image/jpeg'])
  on conflict (id) do update set public = true, file_size_limit = 600000, allowed_mime_types = array['image/png','image/jpeg'];
drop policy if exists "cards anon insert" on storage.objects;
create policy "cards anon insert" on storage.objects for insert to anon with check (bucket_id = 'cards');
drop policy if exists "cards anon update" on storage.objects;
create policy "cards anon update" on storage.objects for update to anon using (bucket_id = 'cards') with check (bucket_id = 'cards');
drop policy if exists "cards public read" on storage.objects;
create policy "cards public read" on storage.objects for select to anon using (bucket_id = 'cards');

-- what a preview may show: shared issues only, no tail, no pup name
create or replace function vp_share_info(p_id uuid)
returns json language sql security definer set search_path = public as $$
  select json_build_object('id', e.id, 'body', e.body, 'topic', e.topic, 'place', split_part(coalesce(e.place, ''), ',', 1),
                           'backs', (select count(*) from backs b where b.entry_id = e.id), 'created_at', e.created_at,
                           'photo', (select m->>'path' from jsonb_array_elements(coalesce(e.media, '[]'::jsonb)) m where m->>'mod' = 'ok' and (m->>'type') like 'image/%' limit 1))
  from entries e where e.id = p_id and e.shared;
$$;
grant execute on function vp_share_info(uuid) to anon;
