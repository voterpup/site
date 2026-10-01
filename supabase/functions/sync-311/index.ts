// City of Vancouver 3-1-1 service requests (Open Government Licence - Vancouver). Weekly counts by type,
// plus the latest located requests for the map. Runs every 6 hours.
import { createClient } from "npm:@supabase/supabase-js@2";
const API = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/3-1-1-service-requests/records";
const CITY = "vancouver";
const RULES: [RegExp, string][] = [
  [/homeless|encampment|shelter/i, "homelessness"], [/rodent|pest|health|needle/i, "health"],
  [/water|sewer|drain|hydrant|flood/i, "utilities"], [/pothole|sidewalk|street light|streetlight|road|curb|sign|signal|lane/i, "infrastructure"],
  [/parking|traffic|bike|transit|vehicle|towing/i, "transit"], [/building|development|rental|housing|tenant|property|permit/i, "housing"],
  [/police|safety|unsafe|fire|hazard/i, "safety"], [/garbage|green bin|recycl|litter|abandoned|graffiti|dump|waste|bin/i, "cleanliness"],
  [/tree|park|playground|beach|field|garden/i, "parks"], [/noise|air|smoke|climate|pollution/i, "climate"],
  [/tax|fee|cost|fine/i, "cost of living"],
];
const topicOf = (t: string) => RULES.find(([re]) => re.test(t))?.[1] ?? "other";
const q = (params: Record<string, string>) => fetch(API + "?" + new URLSearchParams(params), { headers: { "User-Agent": "VoterPupBot/0.1 (+https://voterpup.com; hi@voterpup.com)" } }).then((r) => r.json());

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // counts by type, one query per day for the last 8 days (the API groups by field names only)
  const rows: any[] = [];
  for (let d = 0; d < 8; d++) {
    const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    const where = d === 0 ? "service_request_open_timestamp >= now(days=-1)" : `service_request_open_timestamp >= now(days=-${d + 1}) and service_request_open_timestamp < now(days=-${d})`;
    for (let off = 0; off < 400; off += 100) {
      const r = await q({ select: "service_request_type, count(*) as n", where, group_by: "service_request_type", limit: "100", offset: String(off), order_by: "n desc" });
      for (const x of r.results ?? []) rows.push({ city: CITY, day, rtype: String(x.service_request_type).slice(0, 80), topic: topicOf(String(x.service_request_type)), n: Number(x.n) });
      if ((r.results ?? []).length < 100) break;
    }
  }
  if (rows.length) await db.from("city_reports").upsert(rows, { onConflict: "city,day,rtype" });
  // latest located requests for the map (3 pages of 100)
  let pins: any[] = [];
  for (let off = 0; off < 300; off += 100) {
    const r = await q({ select: "service_request_type, local_area, latitude, longitude, service_request_open_timestamp", where: "geom is not null and service_request_open_timestamp >= now(days=-7)",
      order_by: "service_request_open_timestamp desc", limit: "100", offset: String(off) });
    for (const x of r.results ?? []) {
      if (x.latitude == null || x.longitude == null) continue;
      pins.push({ id: CITY + ":" + x.service_request_open_timestamp + ":" + Math.round(x.latitude * 1e4) + ":" + Math.round(x.longitude * 1e4) + ":" + String(x.service_request_type).slice(0, 20),
        city: CITY, rtype: String(x.service_request_type).slice(0, 80), topic: topicOf(String(x.service_request_type)),
        lat: Math.round(x.latitude * 1e4) / 1e4, lng: Math.round(x.longitude * 1e4) / 1e4, area: x.local_area, ts: x.service_request_open_timestamp });
    }
    if ((r.results ?? []).length < 100) break;
  }
  if (pins.length) await db.from("city_pins").upsert(pins, { onConflict: "id", ignoreDuplicates: true });
  await db.from("city_pins").delete().lt("ts", new Date(Date.now() - 14 * 864e5).toISOString());
  return new Response(JSON.stringify({ count_rows: rows.length, pins: pins.length }));
});
