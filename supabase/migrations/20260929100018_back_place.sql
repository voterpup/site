-- 100015 went live before the backer's place was added: add it now and replace the 3-argument vp_back.
alter table backs add column if not exists place text;
drop function if exists vp_back(text, uuid, boolean);
create or replace function vp_back(p_tail text, p_id uuid, p_on boolean, p_place text default null)
returns json language plpgsql security definer set search_path = public as $$
declare e entries%rowtype;
begin
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  select * into e from entries where id = p_id;
  if not found or not e.shared then raise exception 'that issue is not shared'; end if;
  if e.tail = p_tail then raise exception 'that one is yours'; end if;
  if coalesce(p_on, true) then
    if (select count(*) from backs where tail = p_tail and created_at > now() - interval '1 day') >= 100 then
      raise exception 'that is a lot of backing for one day - try tomorrow';
    end if;
    insert into backs(entry_id, tail, place) values (p_id, p_tail, nullif(left(trim(coalesce(p_place,'')), 120), ''))
      on conflict do nothing;
  else
    delete from backs where entry_id = p_id and tail = p_tail;
  end if;
  return json_build_object('backs', (select count(*) from backs where entry_id = p_id),
                           'backed', exists (select 1 from backs where entry_id = p_id and tail = p_tail));
end $$;
revoke all on function vp_back(text, uuid, boolean, text) from public;
grant execute on function vp_back(text, uuid, boolean, text) to anon;

