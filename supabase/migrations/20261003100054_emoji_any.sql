-- Any emoji from a safe list (no weapons, gestures, flags, symbols that could be read as political or rude).
alter table emoji_reacts drop constraint if exists emoji_reacts_emoji_check;
alter table emoji_reacts add constraint emoji_reacts_emoji_len check (char_length(emoji) between 1 and 8);
create or replace function vp_emoji_ok(p text) returns boolean language sql immutable as $$
  select p = any(array['😂', '🤣', '😊', '😍', '🥰', '😎', '🤩', '🥳', '😮', '😲', '🤯', '🤔', '😅', '😬', '😢', '😭', '😤', '😩', '🙄', '😴', '🤦', '🙌', '👏', '👍', '💪', '🙏', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '💯', '🎉', '🌱', '🌳', '🌸', '☀️', '🌧️', '🚌', '🚲', '🚧', '🕳️', '🗑️', '🐶', '🐾', '🏡', '📍']);
$$;
create or replace function vp_emoji(p_tail text, p_id uuid, p_emoji text)
returns json language plpgsql security definer set search_path = public as $$
declare e entries%rowtype;
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  select * into e from entries where id = p_id;
  if not found or not e.shared then raise exception 'that post is not shared'; end if;
  if e.tail = p_tail then raise exception 'that one is yours'; end if;
  if p_emoji is null then
    delete from emoji_reacts where entry_id = p_id and tail = p_tail;
  else
    if not vp_emoji_ok(p_emoji) then raise exception 'that reaction is not available'; end if;
    insert into emoji_reacts(entry_id, tail, emoji) values (p_id, p_tail, p_emoji)
      on conflict (entry_id, tail) do update set emoji = excluded.emoji, created_at = now();
  end if;
  return vp_emoji_summary(p_id, p_tail);
end $$;

-- tell the owner: a push at most once an hour per pup (the app also shows new reactions on the pup page)
alter table ledgers add column if not exists last_emoji_push timestamptz;
create or replace function vp_kick_emoji_push() returns trigger language plpgsql security definer set search_path = public as $$
declare owner text;
begin
  select tail into owner from entries where id = new.entry_id;
  if owner is null or owner = new.tail then return null; end if;
  update ledgers set last_emoji_push = now()
    where tail = owner and (last_emoji_push is null or last_emoji_push < now() - interval '1 hour');
  if not found then return null; end if;
  perform net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/notify-emoji',
                        headers := '{"Content-Type":"application/json"}'::jsonb,
                        body := json_build_object('entry_id', new.entry_id, 'emoji', new.emoji)::jsonb);
  return null;
end $$;
drop trigger if exists emoji_push on emoji_reacts;
create trigger emoji_push after insert or update of emoji on emoji_reacts for each row execute function vp_kick_emoji_push();

-- new reactions on my posts since a time (for the pup page)
create or replace function vp_new_reactions(p_tail text, p_since timestamptz)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x order by x.last desc), '[]'::json) from (
    select e.id, left(coalesce(nullif(e.body, ''), 'your photo'), 50) body, string_agg(r.emoji, '' order by r.created_at desc) emojis, count(*) n, max(r.created_at) last
    from emoji_reacts r join entries e on e.id = r.entry_id
    where e.tail = p_tail and r.created_at > coalesce(p_since, now() - interval '7 days') and r.tail <> p_tail
    group by e.id, e.body limit 5) x;
$$;
revoke all on function vp_new_reactions(text, timestamptz) from public; grant execute on function vp_new_reactions(text, timestamptz) to anon;
