-- Instant, in-database topic tagging (private text never leaves the DB).
-- topic_src: 'rule' (keywords) | 'ai' (Haiku, shared entries only) | 'user' (never overwritten)
alter table entries add column if not exists topic_src text;

create or replace function vp_guess_topic(p text)
returns text language sql immutable as $$
  select case
    when p ~* '\m(tents?|encampments?|homeless|unhoused|shelters?|sleeping rough|street sleep)' then 'homelessness'
    when p ~* '\m(hospital|doctors?|clinic|er wait|emergency room|health|hygien|unhygien|mental|overdose|nurse|pharmac)' then 'health'
    when p ~* '\m(bus|buses|train|trains|skytrain|transit|traffic|bikes?|cycl|roads?|potholes?|bridges?|parking|commute|sidewalks?|crosswalks?|pedestrian|speeding|intersection)' then 'transit'
    when p ~* '\m(rent|renters?|landlords?|housing|apartments?|condos?|evict|mortgage|rezoning|density|home prices?)' then 'housing'
    when p ~* '\m(crime|theft|stolen|break.?ins?|unsafe|police|assault|drugs?|needles?|violence|robbery)' then 'safety'
    when p ~* '\m(garbage|trash|litter|dirty|graffiti|smell|poop|waste|recycling|filthy)' then 'cleanliness'
    when p ~* '\m(parks?|playgrounds?|trees?|beach|off.?leash|gardens?|pools?|community cent|rinks?|library)' then 'parks'
    when p ~* '\m(climate|pollution|emissions?|heat ?wave|smoke|air quality|flood|noise)' then 'climate'
    when p ~* '\m(prices?|expensive|cost|grocer|taxes|tax|fees?|inflation|wages?|afford)' then 'cost of living'
    else 'other'
  end;
$$;

drop function if exists vp_add_entry(text, text, boolean, jsonb, text);
create or replace function vp_add_entry(p_tail text, p_body text, p_shared boolean,
                                        p_media jsonb default '[]'::jsonb, p_place text default null)
returns json language plpgsql security definer set search_path = public as $$
declare b text; new_id uuid; t text;
begin
  b := coalesce(trim(p_body), '');
  if length(b) > 500 then raise exception 'body must be at most 500 chars'; end if;
  if length(b) = 0 and jsonb_array_length(coalesce(p_media,'[]'::jsonb)) = 0 then
    raise exception 'say it or show it'; end if;
  if jsonb_array_length(coalesce(p_media,'[]'::jsonb)) > 4 then raise exception 'max 4 files'; end if;
  if not exists (select 1 from ledgers where tail = p_tail) then raise exception 'no such pup'; end if;
  t := case when length(b) > 0 then vp_guess_topic(b) end;
  insert into entries(tail, body, shared, media, place, topic, topic_src)
    values (p_tail, b, coalesce(p_shared,false), coalesce(p_media,'[]'::jsonb),
            nullif(trim(coalesce(p_place,'')),''), t, case when t is not null then 'rule' end)
    returning id into new_id;
  return json_build_object('id', new_id, 'topic', t);
end $$;
grant execute on function vp_add_entry(text, text, boolean, jsonb, text) to anon;

-- owner corrects a topic (capability-checked by tail)
create or replace function vp_set_topic(p_tail text, p_id uuid, p_topic text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_topic not in ('housing','homelessness','transit','safety','cost of living','health',
                     'climate','cleanliness','parks','other') then
    raise exception 'unknown topic'; end if;
  update entries set topic = p_topic, topic_src = 'user' where id = p_id and tail = p_tail;
end $$;
grant execute on function vp_set_topic(text, uuid, text) to anon;

-- backfill: untagged entries get rule topics; tents/encampments move off #safety
update entries set topic = vp_guess_topic(body), topic_src = 'rule'
  where topic is null and length(coalesce(body,'')) > 0;
update entries set topic = 'homelessness', topic_src = 'rule'
  where body ~* '\m(tents?|encampments?|homeless|unhoused)' and coalesce(topic_src,'') <> 'user';
update entries set topic_src = 'ai' where topic is not null and topic_src is null;
