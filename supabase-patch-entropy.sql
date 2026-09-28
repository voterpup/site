-- Rerun-safe patch: raise tail entropy 48 -> 80 bits (rerun in SQL Editor)
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
