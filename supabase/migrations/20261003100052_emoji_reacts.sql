-- Emoji reactions on shared posts: one per pup per post (tap again to remove, tap another to switch).
create table if not exists emoji_reacts (
  entry_id uuid not null references entries(id) on delete cascade,
  tail text not null references ledgers(tail) on delete cascade,
  emoji text not null check (emoji in ('lol', 'wow', 'ugh', 'love')),
  created_at timestamptz not null default now(),
  primary key (entry_id, tail));
create index if not exists emoji_reacts_entry on emoji_reacts(entry_id);
alter table emoji_reacts enable row level security;   -- read and written only through the functions below

create or replace function vp_guard_emoji() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform vp_limit('emoji_conn', vp_conn(), 400, interval '1 day', 'That is a lot of reactions for one day. Try again tomorrow.');
  return new;
end $$;
drop trigger if exists guard_emoji on emoji_reacts;
create trigger guard_emoji before insert on emoji_reacts for each row execute function vp_guard_emoji();

create or replace function vp_emoji_summary(p_id uuid, p_tail text) returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'counts', coalesce((select json_object_agg(emoji, n) from (select emoji, count(*) n from emoji_reacts where entry_id = p_id group by emoji) c), '{}'::json),
    'mine', (select emoji from emoji_reacts where entry_id = p_id and tail = p_tail));
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
    if p_emoji not in ('lol', 'wow', 'ugh', 'love') then raise exception 'bad reaction'; end if;
    insert into emoji_reacts(entry_id, tail, emoji) values (p_id, p_tail, p_emoji)
      on conflict (entry_id, tail) do update set emoji = excluded.emoji, created_at = now();
  end if;
  return vp_emoji_summary(p_id, p_tail);
end $$;

-- counts for many posts at once (shared posts, plus the caller's own)
create or replace function vp_emoji_counts(p_ids uuid[], p_tail text default null)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_object_agg(e.id, vp_emoji_summary(e.id, p_tail)), '{}'::json)
  from entries e where e.id = any(p_ids[1:200]) and (e.shared or e.tail = p_tail);
$$;

revoke all on function vp_emoji(text, uuid, text) from public; grant execute on function vp_emoji(text, uuid, text) to anon;
revoke all on function vp_emoji_counts(uuid[], text) from public; grant execute on function vp_emoji_counts(uuid[], text) to anon;
revoke all on function vp_emoji_summary(uuid, text) from public, anon, authenticated;
