-- Sealed drops (voterpup.com/seal): a call sealed between two people until a date; the pup opens it when the day comes.
create table if not exists seals (
  id bigserial primary key,
  code text not null unique,
  created_at timestamptz not null default now(),
  creator_dev text not null,
  creator_name text not null,
  friend_name text not null,
  call_text text not null,
  opens_at timestamptz not null,
  counter_dev text,
  counter_name text,
  counter_text text,
  counter_at timestamptz,
  creator_email text,
  friend_email text,
  creator_mark text,          -- who called it, per participant: creator | friend | both | neither
  friend_mark text,
  notified_at timestamptz,
  src text,
  views int not null default 0
);
create index if not exists seals_open_idx on seals (opens_at) where notified_at is null;
create index if not exists seals_creator_idx on seals (creator_dev);
create index if not exists seals_counter_idx on seals (counter_dev);
alter table seals enable row level security;   -- only the seal edge function (service role) touches it

do $$ declare d text; begin
  d := pg_get_functiondef('vp_track(text,text,text,text,jsonb)'::regprocedure);
  d := replace(d, '''block'',''v2'')', '''block'',''v2'',''seal'')');
  if d not like '%''seal''%' then raise exception 'track patch'; end if; execute d;
end $$;

-- every 10 minutes: mail the people whose seal just opened
select cron.schedule('seal-open-10min', '*/10 * * * *',
  $$ select net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/seal', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"action":"cron"}'::jsonb) $$);
notify pgrst, 'reload schema';
