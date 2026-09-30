-- park furniture: benches -> parks
create or replace function vp_guess_topic(p text)
returns text language sql immutable as $$
  select case
    when p ~* '\m(tents?|encampments?|homeless(ness)?|unhoused|shelters?|sleeping rough)\M' then 'homelessness'
    when p ~* '\m(hospitals?|doctors?|clinics?|health|hygiene|unhygienic|mental|overdoses?|nurses?|pharmac\w*|er wait)\M' then 'health'
    when p ~* '\m(water|power|electricity|outages?|blackouts?|power cuts?|sewage|sewers?|drainage|internet|load.?shedding)\M' then 'utilities'
    when p ~* '\m(sidewalks?|crosswalks?|potholes?|roads?|bridges?|railings?|streetlights?|street lights?|icy|ice|snow|construction|curbs?|pavements?|signage|traffic lights?)\M' then 'infrastructure'
    when p ~* '\m(bus|buses|trains?|skytrain|transit|traffic|bikes?|cycling|cyclists?|parking|commute|pedestrians?|speeding|intersections?)\M' then 'transit'
    when p ~* '\m(rent|rents|renters?|landlords?|housing|apartments?|condos?|evict\w*|mortgages?|rezoning|density|home prices?)\M' then 'housing'
    when p ~* '\m(schools?|teachers?|classrooms?|universit(y|ies)|colleges?|tuition|daycare|childcare)\M' then 'education'
    when p ~* '\m(crime|theft|stolen|break.?ins?|unsafe|police|assaults?|drugs?|needles?|violence|robber(y|ies))\M' then 'safety'
    when p ~* '\m(garbage|trash|litter\w*|dirty|graffiti|smell\w*|poop|waste|recycling|filthy)\M' then 'cleanliness'
    when p ~* '\m(parks?|playgrounds?|bench(es)?|trees?|beach(es)?|off.?leash|gardens?|pools?|community cent\w*|rinks?|librar(y|ies))\M' then 'parks'
    when p ~* '\m(climate|pollution|emissions?|heat ?waves?|smoke|air quality|floods?|flooding|noise|noisy)\M' then 'climate'
    when p ~* '\m(prices?|expensive|costs?|grocer\w*|tax|taxes|fees?|inflation|wages?|afford\w*)\M' then 'cost of living'
    else 'other'
  end;
$$;
