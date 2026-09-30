-- "Goa, India" (a state, no city) must match state-level rows: with two parts, the first is the province.
create or replace function vp_place_match(p_place text, p_level text, p_region text, p_parent text)
returns boolean language sql immutable as $$
  with p as (select array(select lower(trim(x)) from unnest(string_to_array(coalesce(p_place,''), ',')) x) a)
  select case
    when p_level in ('city','council') then array_length(a,1) >= 3 and a[1] = p_region and (p_parent is null or coalesce(a[2],'') = p_parent)
                                          or (array_length(a,1) = 2 and a[1] = p_region and p_parent is null)
    when p_level = 'province' then (case when array_length(a,1) >= 3 then a[2] else a[1] end) = p_region
    when p_level = 'federal'  then coalesce(a[array_length(a,1)], '') = p_region
    else false end
  from p;
$$;
