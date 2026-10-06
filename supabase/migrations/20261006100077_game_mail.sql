-- Guess the wish: an optional email when friends play your game (and the email's link brings you back to your pup on any device).
-- Game-only sign-ups don't get the daily 7 pm report.
alter table mail_subs add column if not exists daily boolean not null default true;
alter table mail_subs add column if not exists game boolean not null default false;
alter table mail_subs add column if not exists last_game timestamptz;
alter table mail_subs add column if not exists last_recover timestamptz;   -- "get my pup back" emails, at most one every 10 minutes

create or replace function vp_set_game_email(p_tail text, p_email text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or length(e) > 120 then raise exception 'that email doesn''t look right'; end if;
  insert into mail_subs(email, tail, consent_src, daily, game) values (e, p_tail, 'game', false, true)
    on conflict (email) do update set tail = excluded.tail, game = true, unsub_at = null, consent_at = now(), fails = 0;
  return json_build_object('ok', true);
end $$;
revoke all on function vp_set_game_email(text, text) from public; grant execute on function vp_set_game_email(text, text) to anon;

create or replace function vp_game_email_status(p_tail text) returns json language sql security definer set search_path = public as $$
  select coalesce((select json_build_object('email', regexp_replace(email, '^(.).*(@.*)$', '\1…\2'), 'on', unsub_at is null and game)
    from mail_subs where tail = p_tail order by game desc, consent_at desc limit 1), 'null'::json);
$$;
grant execute on function vp_game_email_status(text) to anon;

do $$ declare d text; begin
  -- the daily report only goes to people who asked for it
  d := pg_get_functiondef('vp_due_mails()'::regprocedure);
  d := replace(d, 'where m.unsub_at is null and m.fails < 5', 'where m.unsub_at is null and m.daily and m.fails < 5');
  if d not like '%m.daily and%' then raise exception 'due_mails patch'; end if; execute d;
  -- the bell: friends playing your games
  d := pg_get_functiondef('vp_inbox(text)'::regprocedure);
  d := replace(d, $q$and (x->>'days')::int between 0 and 10
)$q$, $q$and (x->>'days')::int between 0 and 10
  union all
  select 'game', pl.created_at,
         '🫣 ' || coalesce(pl.nickname, 'Someone') || case when coalesce(pl.score, 0) > 0 then ' found your answer' else ' couldn''t find your answer' end,
         case when coalesce(pl.score, 0) > 0 then 'Try ' || pl.tries || ' · +' || pl.score || ' · “' || left(g.answer, 50) || '”' else 'You fooled them 😎 · “' || left(g.answer, 50) || '”' end,
         '/m/' || g.code
  from mine_plays pl join mine_games g on g.code = pl.code
  where g.tail = p_tail and pl.done and pl.tail <> p_tail and pl.created_at > now() - interval '30 days'
)$q$);
  if d not like '%''game'', pl.created_at%' then raise exception 'inbox patch'; end if; execute d;
end $$;

do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''pick'',''mine'')', '''pick'',''mine'',''recover'')');
  if d not like '%''recover''%' then raise exception 'track patch'; end if; execute d;
end $$;
