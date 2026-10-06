-- a game before it's sent: the player sees the mix, can roll new decoys, then sends it
create table if not exists mine_drafts (id uuid primary key default gen_random_uuid(), tail text not null references ledgers(tail) on delete cascade, prompt_id int not null references mine_prompts(id),
  answer text not null, nickname text not null, decoys jsonb not null, rolls int not null default 0, created_at timestamptz not null default now());
alter table mine_drafts enable row level security; grant select, insert, update, delete on mine_drafts to service_role;
