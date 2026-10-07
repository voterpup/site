-- "What's broken on your block": reports a pup follows, checked against the City's own data every 3 hours.
create table if not exists block_follows (tail text not null references ledgers(tail) on delete cascade, city text not null, report_id text not null,
  rtype text, block text, opened text, last_status text, created_at timestamptz not null default now(), changed_at timestamptz, primary key (tail, city, report_id));
alter table block_follows enable row level security; grant select, insert, update, delete on block_follows to service_role;
alter table mail_subs add column if not exists follows boolean not null default false;
create or replace function vp_set_follow_email(p_tail text, p_email text) returns json language plpgsql security definer set search_path = public, extensions as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or length(e) > 120 then raise exception 'that email doesn''t look right'; end if;
  insert into mail_subs(email, tail, consent_src, daily, game, follows) values (e, p_tail, 'follow', false, true, true)
    on conflict (email) do update set tail = excluded.tail, follows = true, unsub_at = null, consent_at = now(), fails = 0;
  return json_build_object('ok', true);
end $$;
revoke all on function vp_set_follow_email(text, text) from public; grant execute on function vp_set_follow_email(text, text) to anon;
do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''first_done'',''report'')', '''first_done'',''report'',''block'')');
  if d not like '%''block''%' then raise exception 'track patch'; end if; execute d;
end $$;
select cron.unschedule('block-check-3h') where exists (select 1 from cron.job where jobname = 'block-check-3h');
select cron.schedule('block-check-3h', '17 */3 * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/block', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"action":"check"}'::jsonb) $$);
