create or replace function vp_upcoming(p_place text)
returns json language sql security definer set search_path = public as $$
  select coalesce(json_agg(j), '[]'::json) from (
    select json_build_object('name', name, 'level', level, 'kind', kind, 'topic', topic,
             'vote_date', vote_date, 'days', (vote_date - current_date)) as j
    from elections
    where vote_date >= current_date
      and lower(coalesce(p_place,'')) like '%' || region || '%'
    order by vote_date asc limit 4
  ) s;
$$;
grant execute on function vp_upcoming(text) to anon;
