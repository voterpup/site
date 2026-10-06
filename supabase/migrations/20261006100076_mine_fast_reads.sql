-- the two reads a new visitor waits on, straight from the database (no function cold start)
create or replace function vp_mine_prompts(p_n int default 6) returns json language sql volatile security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', id, 'text', text, 'kind', kind)), '[]'::json)
  from (select id, text, kind from mine_prompts where active order by random() limit least(greatest(p_n, 1), 12)) x;
$$;
create or replace function vp_mine_open(p_code text, p_tail text default null) returns json language sql stable security definer set search_path = public as $$
  select case when g.code is null or g.expires_at < now() then json_build_object('error', 'This game has ended. Ask for a new link 🐾')
    else json_build_object('prompt', p.text, 'nickname', g.nickname, 'own', coalesce(p_tail = g.tail, false),
      'cards', (select json_agg(json_build_object('id', c->>'id', 'text', c->>'text')) from jsonb_array_elements(g.decoys) c),
      'play', (select json_build_object('wrong', pl.wrong, 'tries', pl.tries, 'score', pl.score, 'done', pl.done) from mine_plays pl where pl.code = g.code and pl.tail = p_tail)) end
  from (select 1) one left join mine_games g on g.code = p_code left join mine_prompts p on p.id = g.prompt_id;
$$;
revoke all on function vp_mine_prompts(int) from public; grant execute on function vp_mine_prompts(int) to anon;
revoke all on function vp_mine_open(text, text) from public; grant execute on function vp_mine_open(text, text) to anon;
