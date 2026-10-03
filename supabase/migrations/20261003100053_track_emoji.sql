CREATE OR REPLACE FUNCTION public.vp_track(p_dev text, p_event text, p_tail text DEFAULT NULL::text, p_src text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_dev !~ '^[a-z0-9]{8,32}$' then return; end if;
  if p_event not in ('open','pup_created','issue','reminder_on','reminder_off','install','standalone_open','notif_open','swipe','fetch','share_code','pack','map','flashback','tour_done','report_seen','report_skip','play','snap','emoji') then return; end if;
  if (select count(*) from events where dev = p_dev and ts > now() - interval '1 day') >= 300 then return; end if;
  insert into events(dev, tail, event, src, meta)
    values (p_dev, left(p_tail, 60), p_event, left(regexp_replace(coalesce(p_src,''), '[^a-z0-9_-]', '', 'g'), 20), coalesce(p_meta, '{}'::jsonb));
end $function$;
