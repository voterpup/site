-- "Which one's mine?": answer a fun prompt, hide it among 5 decoys, send the link; friends guess, fewer tries = more points.
create table if not exists mine_prompts (id serial primary key, text text not null unique, kind text not null, active boolean not null default true, source text not null default 'ai', created_at timestamptz not null default now());
create table if not exists mine_decoys (id bigserial primary key, prompt_id int not null references mine_prompts(id) on delete cascade, text text not null, source text not null default 'ai', created_at timestamptz not null default now(), unique (prompt_id, text));
create table if not exists mine_games (code text primary key, tail text not null references ledgers(tail) on delete cascade, prompt_id int not null references mine_prompts(id),
  answer text not null, nickname text not null, decoys jsonb not null, created_at timestamptz not null default now(), expires_at timestamptz not null default now() + interval '14 days');
create table if not exists mine_plays (code text not null references mine_games(code) on delete cascade, tail text not null references ledgers(tail) on delete cascade, nickname text,
  wrong jsonb not null default '[]', tries int not null default 0, score int, done boolean not null default false, created_at timestamptz not null default now(), primary key (code, tail));
create index if not exists mine_games_tail on mine_games (tail, created_at desc);
alter table mine_prompts enable row level security; alter table mine_decoys enable row level security; alter table mine_games enable row level security; alter table mine_plays enable row level security;
grant select, insert, update, delete on mine_prompts, mine_decoys, mine_games, mine_plays to service_role;
grant usage, select on sequence mine_prompts_id_seq, mine_decoys_id_seq to service_role;
do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''emoji'',''pick'')', '''emoji'',''pick'',''mine'')');
  execute d;
end $$;
