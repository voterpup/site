-- Reports by email (the path for phones that can't take notifications). Express consent recorded; every mail carries unsubscribe.
create table if not exists mail_subs (
  email        text primary key,
  tail         text not null references ledgers(tail) on delete cascade,
  tz           text not null default 'America/Vancouver',
  hour         int  not null default 19,
  token        text not null default encode(extensions.gen_random_bytes(12), 'hex'),
  consent_at   timestamptz not null default now(),
  consent_src  text,
  unsub_at     timestamptz,
  last_sent    timestamptz,
  last_vote    date,
  fails        int not null default 0
);
create index if not exists mail_subs_tail_idx on mail_subs(tail);
alter table mail_subs enable row level security;
grant all on mail_subs to service_role;

create or replace function vp_set_email(p_tail text, p_email text, p_tz text default 'America/Vancouver', p_hour int default 19, p_src text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or length(e) > 120 then raise exception 'that email doesn''t look right'; end if;
  if p_hour not between 0 and 23 then raise exception 'bad hour'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_tz) then p_tz := 'America/Vancouver'; end if;
  insert into mail_subs(email, tail, tz, hour, consent_src) values (e, p_tail, p_tz, p_hour, left(coalesce(p_src,''), 20))
    on conflict (email) do update set tail = excluded.tail, tz = excluded.tz, hour = excluded.hour, unsub_at = null, consent_at = now(), fails = 0;
  return json_build_object('ok', true);
end $$;
revoke all on function vp_set_email(text, text, text, int, text) from public;
grant execute on function vp_set_email(text, text, text, int, text) to anon;

create or replace function vp_email_status(p_tail text)
returns json language sql security definer set search_path = public as $$
  select coalesce((select json_build_object('email', regexp_replace(email, '^(.).*(@.*)$', '\1…\2'), 'hour', hour, 'on', unsub_at is null) from mail_subs where tail = p_tail order by consent_at desc limit 1), 'null'::json);
$$;
grant execute on function vp_email_status(text) to anon;

create or replace function vp_email_off(p_tail text)
returns void language sql security definer set search_path = public as $$ update mail_subs set unsub_at = now() where tail = p_tail; $$;
grant execute on function vp_email_off(text) to anon;

-- due now: local clock within 5 minutes of the chosen hour, not sent in 20 h
create or replace function vp_due_mails()
returns table(email text, token text, tail text, name text) language sql security definer set search_path = public as $$
  select m.email, m.token, m.tail, l.name from mail_subs m join ledgers l on l.tail = m.tail,
       lateral (select (now() at time zone m.tz) lt) t
  where m.unsub_at is null and m.fails < 5
    and ((extract(hour from t.lt) * 60 + extract(minute from t.lt)) - (m.hour * 60) + 1440)::int % 1440 < 15
    and (m.last_sent is null or m.last_sent < now() - interval '20 hours');
$$;
revoke all on function vp_due_mails() from public, anon, authenticated; grant execute on function vp_due_mails() to service_role;

create or replace function vp_due_vote_mails()
returns table(email text, token text, tail text, name text, city text, election text) language sql security definer set search_path = public as $$
  select m.email, m.token, m.tail, l.name, split_part(p.place, ',', 1), el.name
  from mail_subs m join ledgers l on l.tail = m.tail,
       lateral (select place from entries e where e.tail = m.tail and e.place is not null order by e.created_at desc limit 1) p,
       lateral (select (now() at time zone m.tz) lt) t,
       lateral (select name from elections el where el.status = 'live' and el.kind = 'election' and el.date_precision = 'day'
                  and el.vote_date = t.lt::date and vp_place_match(p.place, el.level, el.region, el.parent) order by el.level = 'city' desc limit 1) el
  where m.unsub_at is null and extract(hour from t.lt) = 8 and extract(minute from t.lt) < 15
    and (m.last_vote is null or m.last_vote < t.lt::date);
$$;
revoke all on function vp_due_vote_mails() from public, anon, authenticated; grant execute on function vp_due_vote_mails() to service_role;

select cron.unschedule('send-mail-15min') where exists (select 1 from cron.job where jobname = 'send-mail-15min');
select cron.schedule('send-mail-15min', '*/15 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/send-mail',
       headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$);
