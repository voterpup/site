-- v2 prototype (voterpup.com/v2, "your feed vs you"): one anonymous event name, the step goes in meta.
do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''first_done'',''report'',''block'')', '''first_done'',''report'',''block'',''v2'')');
  if d not like '%''v2''%' then raise exception 'track patch'; end if; execute d;
end $$;
notify pgrst, 'reload schema';
