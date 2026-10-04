-- Add the spot to one of your own issues later (for Street View), e.g. one made from a first-screen tile without location.
create or replace function vp_set_spot(p_tail text, p_id uuid, p_lat double precision, p_lng double precision, p_spot text) returns json language plpgsql security definer set search_path = public as $$
declare sp text := nullif(left(trim(coalesce(p_spot, '')), 80), '');
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'bad location'; end if;
  update entries set lat = round(p_lat::numeric, 4), lng = round(p_lng::numeric, 4), spot = coalesce(sp, round(p_lat::numeric, 4) || ', ' || round(p_lng::numeric, 4))
   where id = p_id and tail = p_tail and source is null;
  if not found then raise exception 'not your issue'; end if;
  return json_build_object('spot', (select spot from entries where id = p_id));
end $$;
revoke all on function vp_set_spot(text, uuid, double precision, double precision, text) from public;
grant execute on function vp_set_spot(text, uuid, double precision, double precision, text) to anon;
