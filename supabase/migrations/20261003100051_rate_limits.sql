-- Spam guard without accounts: per-connection limits on new pups, posts, shares and "same here".
-- The connection is stored only as a salted hash and forgotten after 2 days. Generous limits, because phones on
-- mobile data share addresses (carrier NAT) and the booth hotspot puts many people on one address.
drop function if exists vp_ip_probe();
create extension if not exists pgcrypto with schema extensions;

create table if not exists rate_hits (kind text not null, key text not null, ts timestamptz not null default now());
create index if not exists rate_hits_idx on rate_hits (kind, key, ts);
alter table rate_hits enable row level security;   -- no policies: nobody reads it through the API

create or replace function vp_conn() returns text language sql stable security definer set search_path = public, extensions as $$
  select case when ip is null or ip = '' then null
              else encode(digest('vp-conn-2026:' || ip, 'sha256'), 'hex') end
  from (select split_part(coalesce(nullif(current_setting('request.headers', true), '')::json->>'cf-connecting-ip',
                                   nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ''), ',', 1) ip) x;
$$;

create or replace function vp_limit(p_kind text, p_key text, p_max int, p_window interval, p_msg text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_key is null then return; end if;   -- server jobs and the dashboard have no connection: never limited
  if (select count(*) from rate_hits where kind = p_kind and key = p_key and ts > now() - p_window) >= p_max then
    raise exception '%', p_msg using errcode = 'P0001';
  end if;
  insert into rate_hits(kind, key) values (p_kind, p_key);
  if random() < 0.02 then delete from rate_hits where ts < now() - interval '2 days'; end if;
end $$;

-- new pups
create or replace function vp_guard_pup() returns trigger language plpgsql security definer set search_path = public as $$
declare c text := vp_conn();
begin
  perform vp_limit('pup_h', c, 20, interval '1 hour', 'Lots of new pups from this connection. Try again in a little while.');
  perform vp_limit('pup_d', c, 60, interval '1 day', 'Lots of new pups from this connection today. Try again tomorrow.');
  return new;
end $$;
drop trigger if exists guard_pup on ledgers;
create trigger guard_pup before insert on ledgers for each row execute function vp_guard_pup();

-- posts and shares
create or replace function vp_guard_entry() returns trigger language plpgsql security definer set search_path = public as $$
declare c text := vp_conn();
begin
  if tg_op = 'INSERT' then
    perform vp_limit('post_pup', new.tail, 30, interval '1 day', 'Your pup has had a big day. Try again tomorrow.');
    perform vp_limit('post_conn', c, 120, interval '1 day', 'Lots of posts from this connection today. Try again tomorrow.');
  end if;
  if new.shared and (tg_op = 'INSERT' or not coalesce(old.shared, false)) then
    perform vp_limit('share_pup', new.tail, 10, interval '1 day', 'That is a lot of sharing for one day. Keep it private for now, or share tomorrow.');
    perform vp_limit('share_conn', c, 40, interval '1 day', 'Lots of shared posts from this connection today. Try again tomorrow.');
  end if;
  return new;
end $$;
drop trigger if exists guard_entry on entries;
create trigger guard_entry before insert or update of shared on entries for each row execute function vp_guard_entry();

-- "same here": a connection counts at most 5 times on one issue, so a pile of pups can't pump a number
alter table backs add column if not exists conn text;
create or replace function vp_guard_back() returns trigger language plpgsql security definer set search_path = public as $$
declare c text := vp_conn();
begin
  new.conn := c;
  if c is not null then
    if (select count(*) from backs where entry_id = new.entry_id and conn = c) >= 5 then
      raise exception 'Enough "same here" from this connection on this one already.' using errcode = 'P0001';
    end if;
    perform vp_limit('back_conn', c, 300, interval '1 day', 'That is a lot of "same here" for one day. Try again tomorrow.');
  end if;
  return new;
end $$;
drop trigger if exists guard_back on backs;
create trigger guard_back before insert on backs for each row execute function vp_guard_back();

revoke all on function vp_conn() from public, anon, authenticated;
revoke all on function vp_limit(text, text, int, interval, text) from public, anon, authenticated;
