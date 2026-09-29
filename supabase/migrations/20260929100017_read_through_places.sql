-- Read-through place cache: a known place follows its update cycle; a NEW place kicks discovery at once.
drop function if exists vp_note_place(text);
create or replace function vp_note_place(p_place text)
returns json language plpgsql security definer set search_path = public as $$
declare p text := trim(coalesce(p_place, '')); w place_watch%rowtype;
begin
  if length(p) < 3 or length(p) > 120
     or p !~ '^[[:alpha:][:space:].''’()-]+(, [[:alpha:][:space:].''’()-]+){1,3}$' then
    return json_build_object('status', 'invalid');
  end if;
  update place_watch set last_requested = now(), requests = requests + 1 where place = p returning * into w;
  if found then
    return json_build_object('status', case when w.last_checked is null then 'checking' else 'checked' end,
                             'last_checked', w.last_checked);
  end if;
  if (select count(*) from place_watch where first_seen > now() - interval '1 day') >= 100 then
    return json_build_object('status', 'busy');
  end if;
  insert into place_watch(place) values (p) on conflict (place) do nothing;
  return json_build_object('status', 'checking', 'last_checked', null);
end $$;
revoke all on function vp_note_place(text) from public;
grant execute on function vp_note_place(text) to anon;

-- new place -> start the discovery workflow now (the edge function only dispatches while
-- never-checked places exist, so calling it directly does nothing useful)
create or replace function vp_kick_discovery() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/kick-discovery',
                        headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);
  return null;
end $$;
drop trigger if exists place_watch_kick on place_watch;
create trigger place_watch_kick after insert on place_watch for each row execute function vp_kick_discovery();
