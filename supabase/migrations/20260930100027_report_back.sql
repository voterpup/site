-- "Oreo reports back": booth social proof, smarter reminders, and a vote-morning push.
alter table push_subs add column if not exists last_vote_push date;

-- social proof at the booth: what happened in this city this week
create or replace function vp_place_stats(p_place text)
returns json language sql security definer set search_path = public as $$
  with c as (select lower(trim(split_part(coalesce(p_place,''), ',', 1))) city),
  e as (select * from entries, c where created_at > now() - interval '7 days'
          and lower(trim(split_part(coalesce(place,''), ',', 1))) = c.city),
  t as (select topic, count(*) n from e where topic is not null and topic <> 'other' group by topic order by n desc limit 1)
  select json_build_object('pups_week', (select count(distinct tail) from e), 'issues_week', (select count(*) from e),
                           'top_topic', (select topic from t), 'top_count', (select n from t));
$$;
grant execute on function vp_place_stats(text) to anon;

-- what the reminder should say for one pup (service role only)
create or replace function vp_reminder_facts(p_tail text)
returns json language sql security definer set search_path = public as $$
  with mine as (select * from entries where tail = p_tail),
  place as (select place from mine where place is not null order by created_at desc limit 1),
  s as (select vp_place_stats((select place from place)) st)
  select json_build_object('entries', (select count(*) from mine),
                           'backs', (select count(*) from backs b join mine m on m.id = b.entry_id),
                           'city', split_part((select place from place), ',', 1),
                           'stats', (select st from s));
$$;
revoke all on function vp_reminder_facts(text) from public, anon, authenticated;
grant execute on function vp_reminder_facts(text) to service_role;

-- vote-morning: subs whose local clock is 08:00-08:05 on a day their place votes
create or replace function vp_due_vote_pushes()
returns table(endpoint text, p256dh text, auth text, tail text, name text, city text, election text)
language sql security definer set search_path = public as $$
  select s.endpoint, s.p256dh, s.auth, s.tail, l.name, split_part(p.place, ',', 1), el.name
  from push_subs s join ledgers l on l.tail = s.tail,
       lateral (select place from entries e where e.tail = s.tail and e.place is not null order by e.created_at desc limit 1) p,
       lateral (select (now() at time zone s.tz) lt) t,
       lateral (select name from elections el where el.status = 'live' and el.kind = 'election' and el.date_precision = 'day'
                  and el.vote_date = t.lt::date and vp_place_match(p.place, el.level, el.region, el.parent)
                order by el.level = 'city' desc limit 1) el
  where extract(hour from t.lt) = 8 and extract(minute from t.lt) < 5
    and (s.last_vote_push is null or s.last_vote_push < t.lt::date);
$$;
revoke all on function vp_due_vote_pushes() from public, anon, authenticated;
grant execute on function vp_due_vote_pushes() to service_role;
