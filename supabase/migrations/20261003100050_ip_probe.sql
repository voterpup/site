create or replace function vp_ip_probe() returns json language sql security definer set search_path = public as $$
  select json_build_object('xff', current_setting('request.headers', true)::json->>'x-forwarded-for',
                           'cf', current_setting('request.headers', true)::json->>'cf-connecting-ip',
                           'real', current_setting('request.headers', true)::json->>'x-real-ip');
$$;
grant execute on function vp_ip_probe() to anon;
