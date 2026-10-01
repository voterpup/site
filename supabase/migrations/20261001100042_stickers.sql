-- Booth stickers: the person asks for one from their own phone (name only, never the private link); the table laptop prints it.
create table if not exists print_jobs (
  id bigserial primary key, name text not null, place text, booth text not null default 'main', dev text,
  created_at timestamptz not null default now(), printed_at timestamptz
);
alter table print_jobs enable row level security;
create table if not exists booth_config (k text primary key, v text not null);
alter table booth_config enable row level security;
insert into booth_config(k, v) values ('print_key', 'a5e8d267bae3c94a331db9fe') on conflict (k) do update set v = excluded.v;

create or replace function vp_sticker_request(p_name text, p_place text default null, p_dev text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare n text := left(regexp_replace(coalesce(p_name, ''), '[^[:alnum:] .''’-]', '', 'g'), 24); id bigint;
begin
  if length(trim(n)) = 0 then raise exception 'name'; end if;
  if (select count(*) from print_jobs where created_at > now() - interval '1 minute') >= 20 then raise exception 'busy'; end if;
  if p_dev is not null and (select count(*) from print_jobs where dev = p_dev and created_at > now() - interval '1 hour') >= 3 then raise exception 'enough'; end if;
  insert into print_jobs(name, place, dev) values (trim(n), left(p_place, 80), left(p_dev, 32)) returning print_jobs.id into id;
  return id;
end $$;
grant execute on function vp_sticker_request(text, text, text) to anon;

create or replace function vp_print_queue(p_key text)
returns json language sql security definer set search_path = public as $$
  select case when p_key = (select v from booth_config where k = 'print_key')
    then (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'place', place, 'at', created_at) order by id), '[]'::json)
          from print_jobs where printed_at is null and created_at > now() - interval '2 hours')
    else null end;
$$;
grant execute on function vp_print_queue(text) to anon;

create or replace function vp_print_done(p_key text, p_id bigint)
returns void language sql security definer set search_path = public as $$
  update print_jobs set printed_at = now() where id = p_id and p_key = (select v from booth_config where k = 'print_key');
$$;
grant execute on function vp_print_done(text, bigint) to anon;
