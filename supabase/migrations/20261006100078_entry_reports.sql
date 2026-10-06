-- Report a public post. A child-safety report hides it at once; any other kind hides it after two reports.
-- Every report lands in svc_errors so the founder alert email picks it up for review.
create table if not exists entry_reports (entry_id uuid not null references entries(id) on delete cascade, reporter text not null, reason text not null,
  created_at timestamptz not null default now(), primary key (entry_id, reporter));
alter table entry_reports enable row level security; grant select, insert, update, delete on entry_reports to service_role;
create or replace function vp_report_entry(p_reporter text, p_entry uuid, p_reason text) returns json language plpgsql security definer set search_path = public as $$
declare r text := case when p_reason in ('child','sexual','violence','hate','personal','spam','other') then p_reason else 'other' end; n int;
begin
  if coalesce(length(p_reporter), 0) < 6 then raise exception 'bad reporter'; end if;
  if not exists (select 1 from entries where id = p_entry and shared and source is null) then return json_build_object('ok', true); end if;
  insert into entry_reports(entry_id, reporter, reason) values (p_entry, left(p_reporter, 80), r) on conflict do nothing;
  select count(*) into n from entry_reports where entry_id = p_entry;
  if r = 'child' or n >= 2 then update entries set shared = false where id = p_entry; end if;
  insert into svc_errors(svc, msg) values (case when r = 'child' then 'REPORT-CHILD-SAFETY' else 'report' end,
    'Post ' || p_entry || ' reported (' || r || '), ' || n || ' report(s)' || case when r = 'child' or n >= 2 then '; hidden from public' else '' end);
  return json_build_object('ok', true);
end $$;
revoke all on function vp_report_entry(text, uuid, text) from public; grant execute on function vp_report_entry(text, uuid, text) to anon;
