-- A changed schedule starts fresh: a new time set today still fires today.
create or replace function vp_set_reminder(p_tail text, p_endpoint text, p_p256dh text, p_auth text,
                                           p_tz text, p_freq text, p_hour int, p_minute int)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if coalesce(p_endpoint,'') !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad subscription'; end if;
  if length(coalesce(p_p256dh,'')) not between 40 and 200 or length(coalesce(p_auth,'')) not between 10 and 100 then raise exception 'bad keys'; end if;
  if p_freq not in ('daily','2days','weekly') then raise exception 'bad frequency'; end if;
  if p_hour not between 0 and 23 or p_minute not between 0 and 59 then raise exception 'bad time'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then p_tz := 'UTC'; end if;
  insert into push_subs(endpoint, p256dh, auth, tail, tz, freq, hour, minute)
    values (p_endpoint, p_p256dh, p_auth, p_tail, p_tz, p_freq, p_hour, p_minute)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, tail = excluded.tail,
    tz = excluded.tz, freq = excluded.freq, hour = excluded.hour, minute = excluded.minute, fails = 0,
    last_sent = case when (push_subs.freq, push_subs.hour, push_subs.minute, push_subs.tz) is distinct from (excluded.freq, excluded.hour, excluded.minute, excluded.tz)
                     then null else push_subs.last_sent end;
  return json_build_object('ok', true);
end $$;
revoke all on function vp_set_reminder(text,text,text,text,text,text,int,int) from public;
grant execute on function vp_set_reminder(text,text,text,text,text,text,int,int) to anon;
