-- Private media: stored URLs -> paths, strict validation on write, bucket goes private.
-- Apply ONLY after vp-read (signer) + the path-aware client are live (they are, as of this migration).

update entries set media = (
  select coalesce(jsonb_agg(
           case when m ? 'url'
             then jsonb_build_object('path', regexp_replace(m->>'url', '^.*/storage/v1/object/(public/)?media/', ''),
                                     'type', m->>'type')
             else m end), '[]'::jsonb)
  from jsonb_array_elements(media) m)
where media::text like '%/storage/v1/object/%';

drop function if exists vp_add_entry(text, text, boolean, jsonb, text);
create or replace function vp_add_entry(p_tail text, p_body text, p_shared boolean,
                                        p_media jsonb default '[]'::jsonb, p_place text default null)
returns json language plpgsql security definer set search_path = public as $$
declare b text; new_id uuid; t text; m jsonb; clean jsonb := '[]'::jsonb;
begin
  b := coalesce(trim(p_body), '');
  if length(b) > 500 then raise exception 'body must be at most 500 chars'; end if;
  if jsonb_typeof(coalesce(p_media,'[]'::jsonb)) <> 'array' then raise exception 'bad media'; end if;
  if jsonb_array_length(coalesce(p_media,'[]'::jsonb)) > 4 then raise exception 'max 4 files'; end if;
  for m in select * from jsonb_array_elements(coalesce(p_media,'[]'::jsonb)) loop
    if coalesce(m->>'path','') !~ '^[0-9a-f-]{8,40}\.[a-z0-9]{1,5}$'
       or coalesce(m->>'type','') !~ '^(image|video)/[a-z0-9.+-]+$' then
      raise exception 'bad media item';
    end if;
    clean := clean || jsonb_build_array(jsonb_build_object('path', m->>'path', 'type', m->>'type'));
  end loop;
  if length(b) = 0 and jsonb_array_length(clean) = 0 then raise exception 'say it or show it'; end if;
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  t := case when length(b) > 0 then vp_guess_topic(b) end;
  insert into entries(tail, body, shared, media, place, topic, topic_src)
    values (p_tail, b, coalesce(p_shared,false), clean,
            nullif(trim(coalesce(p_place,'')),''), t, case when t is not null then 'rule' end)
    returning id into new_id;
  return json_build_object('id', new_id, 'topic', t);
end $$;
grant execute on function vp_add_entry(text, text, boolean, jsonb, text) to anon;

update storage.buckets set public = false where id = 'media';
