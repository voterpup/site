-- Rename a pup. Only the display name changes: the private link (tail) stays the same,
-- so stickers and saved links keep working.
create or replace function vp_rename_ledger(p_tail text, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare n text := trim(coalesce(p_name, ''));
begin
  if length(n) < 1 or length(n) > 24 then raise exception 'name must be 1-24 chars'; end if;
  update ledgers set name = n where tail = p_tail;
  if not found then raise exception 'no such pup'; end if;
  return json_build_object('name', n);
end $$;
revoke all on function vp_rename_ledger(text, text) from public;
grant execute on function vp_rename_ledger(text, text) to anon;
