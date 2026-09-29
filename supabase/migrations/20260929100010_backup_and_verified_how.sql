-- (a) Fix: address-level applications are #housing ("Broadway" contains "road")
update elections set topic = 'housing'
  where kind = 'voice' and scope = 'site'
    and name ~* '(development application|developent application|rezoning|text amendment|odp amendment)';

-- (b) VERIFIED how-to text (human-written from official sources, Sep 29 2026). Pushing this = approval.
update elections set how_ok = true, how =
'• Vote Oct 17, 8am–8pm, or at advance voting Oct 3, 7, 10 or 13 (8am–8pm).
• Not on the voters list? You can register at the voting place — bring 2 pieces of ID. See: Voter guide.
• Who can vote and where: see Voter guide.
• Can''t vote yet? You can still comment on open city consultations and speak at council public hearings.'
where name = 'Vancouver municipal election';

update elections set how_ok = true, how =
'• Election day is Oct 24, 2026.
• Registration, where to vote, and early or mail-in options: see Elections BC.
• Can''t vote yet? You can still comment on open city consultations and speak at council public hearings.'
where name = 'BC provincial election';

update elections set how_ok = true, how =
'• Scheduled for Oct 15, 2029 under the fixed-date law (an election can be called earlier).
• Registration and voting details: see Elections Canada.'
where name = 'Canadian federal election';

update elections set how_ok = true, how =
'• This question is on the Oct 17 Vancouver ballot — vote on it Oct 17 or at advance voting Oct 3, 7, 10 or 13 (8am–8pm).
• Read the exact wording before you vote: see Read the exact ballot questions.
• Not on the voters list? Register at the voting place with 2 pieces of ID.
• Can''t vote yet? You can still comment on open city consultations and speak at council public hearings.'
where kind = 'decision' and region = 'vancouver' and vote_date = date '2026-10-17';

-- (c) Optional Google backup of a pup (email used ONLY to restore links)
create table if not exists ledger_owners (
  user_id uuid not null references auth.users(id) on delete cascade,
  tail text not null references ledgers(tail) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, tail)
);
alter table ledger_owners enable row level security;
grant all on ledger_owners to service_role;

create or replace function vp_claim_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare n text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select name into n from ledgers where tail = p_tail;
  if n is null then raise exception 'no such pup'; end if;
  insert into ledger_owners(user_id, tail) values (auth.uid(), p_tail) on conflict do nothing;
  return json_build_object('name', n);
end $$;

create or replace function vp_my_ledgers()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('tail', l.tail, 'name', l.name, 'created_at', l.created_at)
                  order by l.created_at desc), '[]'::json)
  from ledger_owners o join ledgers l on l.tail = o.tail
  where o.user_id = auth.uid();
$$;

revoke all on function vp_claim_ledger(text) from public, anon;
revoke all on function vp_my_ledgers() from public, anon;
grant execute on function vp_claim_ledger(text) to authenticated;
grant execute on function vp_my_ledgers() to authenticated;
