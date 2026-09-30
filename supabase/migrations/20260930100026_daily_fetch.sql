-- The daily fetch: (a) issues can be marked fixed, (b) the owner gets a push when someone backs
-- their issue (at most one such push per pup per 6 hours).
alter table entries add column if not exists fixed_at timestamptz;
alter table ledgers add column if not exists last_back_push timestamptz;

create or replace function vp_set_fixed(p_tail text, p_id uuid, p_fixed boolean)
returns void language sql security definer set search_path = public as $$
  update entries set fixed_at = case when p_fixed then now() end where id = p_id and tail = p_tail;
$$;
revoke all on function vp_set_fixed(text, uuid, boolean) from public;
grant execute on function vp_set_fixed(text, uuid, boolean) to anon;

create or replace function vp_get_ledger(p_tail text)
returns json language plpgsql security definer set search_path = public as $$
declare l ledgers%rowtype; es json; bk json;
begin
  select * into l from ledgers where tail = p_tail;
  if not found then return null; end if;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'shared', e.shared, 'ts', e.created_at,
           'media', e.media, 'topic', e.topic, 'place', e.place, 'fixed_at', e.fixed_at,
           'backs', (select count(*) from backs b where b.entry_id = e.id))
           order by e.created_at desc), '[]'::json)
    into es from entries e where e.tail = p_tail;
  select coalesce(json_agg(json_build_object(
           'id', e.id, 'body', e.body, 'ts', e.created_at, 'topic', e.topic, 'place', e.place,
           'media', e.media, 'pup', o.name, 'backed_at', b.created_at, 'fixed_at', e.fixed_at,
           'backs', (select count(*) from backs x where x.entry_id = e.id))
           order by b.created_at desc), '[]'::json)
    into bk from backs b join entries e on e.id = b.entry_id join ledgers o on o.tail = e.tail
    where b.tail = p_tail and e.shared;
  return json_build_object('name', l.name, 'created_at', l.created_at, 'entries', es, 'backed', bk);
end $$;

-- push the owner when their issue gets backed (rate-limited per pup)
create or replace function vp_kick_back_push() returns trigger language plpgsql security definer set search_path = public as $$
declare owner text;
begin
  select tail into owner from entries where id = new.entry_id;
  if owner is null or owner = new.tail then return null; end if;
  update ledgers set last_back_push = now()
    where tail = owner and (last_back_push is null or last_back_push < now() - interval '6 hours');
  if not found then return null; end if;
  perform net.http_post(url := 'https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/notify-back',
                        headers := '{"Content-Type":"application/json"}'::jsonb,
                        body := json_build_object('entry_id', new.entry_id)::jsonb);
  return null;
end $$;
drop trigger if exists backs_push on backs;
create trigger backs_push after insert on backs for each row execute function vp_kick_back_push();
