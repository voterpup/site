do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''recover'')', '''recover'',''first_done'',''report'')');
  if d not like '%''first_done''%' then raise exception 'track patch'; end if; execute d;
end $$;
