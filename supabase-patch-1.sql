-- PATCH 1 (rerun-safe): 80-bit tails + The Pack board. Paste whole file in SQL Editor, Run.
create or replace function vp_create_ledger(p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare t text; n text;
begin
  n := trim(p_name);
  if length(n) < 1 or length(n) > 24 then raise exception 'name must be 1-24 chars'; end if;
  t := lower(regexp_replace(n, '[^a-zA-Z0-9]+', '-', 'g'))
       || '~' || encode(gen_random_bytes(10), 'hex');
  insert into ledgers(tail, name) values (t, n);
  return json_build_object('tail', t, 'name', n);
end $$;

-- The Pack: ONLY entries their owners chose to share, newest first, pup-name attribution
create or replace function vp_shared_board()
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('body', e.body, 'ts', e.created_at, 'pup', l.name) as j
    from entries e join ledgers l on l.tail = e.tail
    where e.shared order by e.created_at desc limit 100
  ) s;
$$;
grant execute on function vp_shared_board() to anon;
