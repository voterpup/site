-- The notifications bell: everything that happened to this pup, newest first (same-heres, reactions, group chat and
-- topics, knocks at the door, being let in, new issues near you, voting day coming). Read state lives on the phone.
create or replace function vp_inbox(p_tail text) returns json language sql stable security definer set search_path = public as $$
with me as (select l.tail, l.name, (select e.place from entries e where e.tail = l.tail and e.place is not null order by e.created_at desc limit 1) place
            from ledgers l where l.tail = p_tail),
rows as (
  select 'back' kind, max(bk.created_at) ts,
         '🐾 ' || count(*) || case when count(*) = 1 then ' neighbour feels the same' else ' neighbours feel the same' end title,
         '“' || left(coalesce(nullif(e.body, ''), 'your photo'), 70) || '”' body, '/p/' || p_tail url
  from backs bk join entries e on e.id = bk.entry_id
  where e.tail = p_tail and bk.tail is distinct from p_tail and bk.created_at > now() - interval '30 days'
  group by e.id, e.body, date_trunc('day', bk.created_at)
  union all
  select 'emoji', max(r.created_at), left(string_agg(r.emoji, '' order by r.created_at desc), 12) || ' New reactions',
         '“' || left(coalesce(nullif(e.body, ''), 'your photo'), 70) || '”', '/p/' || p_tail
  from emoji_reacts r join entries e on e.id = r.entry_id
  where e.tail = p_tail and r.tail <> p_tail and r.created_at > now() - interval '30 days'
  group by e.id, e.body, date_trunc('day', r.created_at)
  union all
  select case when m.item_id is null then 'chat' else 'topic' end, m.created_at,
         case when m.item_id is null then '💬 ' || p.name
              else (case when i.entry_id is null then '📌 ' else '🐾 ' end) || l2.name || (case when i.entry_id is null then ' started a topic' else ' shared an issue' end) end,
         case when m.item_id is null then l2.name || ': ' || left(coalesce(m.body, '📷'), 70) else left(coalesce(i.body, ''), 70) || ' · vote?' end,
         '/packs/' || p.id
  from pack_messages m join pack_members pm on pm.pack_id = m.pack_id and pm.tail = p_tail and pm.status = 'active'
       join packs p on p.id = m.pack_id join ledgers l2 on l2.tail = m.tail left join pack_items i on i.id = m.item_id
  where m.tail <> p_tail and m.mod = 'ok' and m.created_at > now() - interval '30 days'
  union all
  select 'knock', pm.joined_at, '🚪 ' || l2.name || ' wants to join', p.name || ' · tap to let them in', '/packs/' || p.id
  from pack_members pm join packs p on p.id = pm.pack_id join ledgers l2 on l2.tail = pm.tail
  where p.owner_tail = p_tail and pm.status = 'pending' and pm.tail <> p_tail
  union all
  select 'in', pm.joined_at, '✅ You’re in ' || p.name, 'Say hi 🐾', '/packs/' || p.id
  from pack_members pm join packs p on p.id = pm.pack_id
  where pm.tail = p_tail and pm.status = 'active' and pm.role = 'member' and pm.joined_at > now() - interval '30 days'
  union all
  select 'near', e.created_at, '🏙️ New near you', '“' || left(coalesce(nullif(e.body, ''), '📷'), 70) || '” — ' || l2.name, '/pack'
  from entries e join ledgers l2 on l2.tail = e.tail, me
  where e.shared and e.source is null and e.tail <> p_tail and e.place = me.place and e.created_at > now() - interval '7 days'
  union all
  select 'vote', (x->>'vote_date')::date::timestamptz - interval '10 days',
         '🗳️ ' || (x->>'name') || ' in ' || (x->>'days') || ' day' || case when (x->>'days') = '1' then '' else 's' end,
         'Your Memory Lane will be ready that morning.', '/p/' || p_tail || '?flash=1'
  from me, json_array_elements(vp_upcoming(me.place)) x
  where me.place is not null and x->>'kind' = 'election' and (x->>'days')::int between 0 and 10
)
select coalesce(json_agg(json_build_object('kind', r.kind, 'ts', r.ts, 'title', r.title, 'body', r.body, 'url', r.url) order by r.ts desc), '[]'::json)
from (select * from rows order by ts desc limit 60) r;
$$;
revoke all on function vp_inbox(text) from public; grant execute on function vp_inbox(text) to anon;
