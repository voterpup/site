-- The first-time "done" screen: how many pups in your city listed the same issue (a count only, nothing about who),
-- and an email for voting morning only (no daily report).
create or replace function vp_same_issue_count(p_place text, p_body text) returns int language sql stable security definer set search_path = public as $$
  select count(distinct e.tail)::int from entries e
  where lower(trim(e.body)) = lower(trim(coalesce(p_body, ''))) and e.source is null
    and lower(trim(split_part(coalesce(e.place, ''), ',', 1))) = lower(trim(split_part(coalesce(p_place, ''), ',', 1)));
$$;
revoke all on function vp_same_issue_count(text, text) from public; grant execute on function vp_same_issue_count(text, text) to anon;

create or replace function vp_set_vote_email(p_tail text, p_email text, p_tz text default 'America/Vancouver') returns json language plpgsql security definer set search_path = public, extensions as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or length(e) > 120 then raise exception 'that email doesn''t look right'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then p_tz := 'America/Vancouver'; end if;
  insert into mail_subs(email, tail, tz, consent_src, daily, game) values (e, p_tail, p_tz, 'vote', false, true)
    on conflict (email) do update set tail = excluded.tail, tz = excluded.tz, unsub_at = null, consent_at = now(), fails = 0, game = true;
  return json_build_object('ok', true);
end $$;
revoke all on function vp_set_vote_email(text, text, text) from public; grant execute on function vp_set_vote_email(text, text, text) to anon;
