-- every notification points at the exact item: the issue (?e=<id>) or, for a neighbour's issue, /issue/<id>
do $$ declare d text; begin
  d := pg_get_functiondef('vp_inbox(text)'::regprocedure);
  d := replace(d, $q$'”' body, '/p/' || p_tail url$q$, $q$'”' body, '/p/' || p_tail || '?e=' || e.id url$q$);
  d := replace(d, $q$'”', '/p/' || p_tail
  from emoji_reacts$q$, $q$'”', '/p/' || p_tail || '?e=' || e.id
  from emoji_reacts$q$);
  d := replace(d, $q$|| l2.name, '/pack'$q$, $q$|| l2.name, '/issue/' || e.id$q$);
  if d not like '%?e='' || e.id url%' or d not like '%/issue/'' || e.id%' then raise exception 'inbox patch did not apply'; end if;
  execute d;
  d := pg_get_functiondef('vp_reminder_facts(text)'::regprocedure);
  d := replace(d, 'ranked as (select body, vp_weekly_rank(id) rk,', 'ranked as (select id, body, vp_weekly_rank(id) rk,');
  d := replace(d, $q$json_build_object('body', body, 'rank', rk, 'city', city) from best$q$, $q$json_build_object('id', id, 'body', body, 'rank', rk, 'city', city) from best$q$);
  if d not like '%''id'', id, ''body''%' then raise exception 'facts patch did not apply'; end if;
  execute d;
end $$;
