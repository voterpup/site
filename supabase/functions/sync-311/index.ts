// Official 3-1-1 / service-request open data for every city that publishes it. Weekly counts by type, plus the
// latest located requests for the map. Runs every 6 hours. Add a city = add one line to SOCRATA below.
import { createClient } from "npm:@supabase/supabase-js@2";
const UA = { "User-Agent": "VoterPupBot/0.2 (+https://voterpup.com; hi@voterpup.com)" };
const RULES: [RegExp, string][] = [
  [/homeless|encampment|shelter/i, "homelessness"], [/rodent|pest|health|needle|unsanitary|dead animal|mold/i, "health"],
  [/water|sewer|drain|hydrant|flood/i, "utilities"], [/pothole|sidewalk|street light|streetlight|road|curb|sign|signal|lane|street condition|snow|ice/i, "infrastructure"],
  [/tree|park|playground|beach|field|garden|weed|grass|vegetation|hedge/i, "parks"],
  [/parking|traffic|bike|transit|vehicle|towing|driveway|abandoned vehicle/i, "transit"], [/heat|hot water|building|development|rental|housing|tenant|property|permit|plumbing|paint|elevator/i, "housing"],
  [/police|safety|unsafe|fire|hazard|drug|weapon/i, "safety"], [/garbage|green bin|recycl|litter|abandoned|graffiti|dump|waste|bin|sanitation|trash|bulky/i, "cleanliness"],
  [/tree|park|playground|beach|field|garden|weed|grass/i, "parks"], [/noise|air|smoke|climate|pollution|odou?r/i, "climate"],
  [/tax|fee|cost|fine|bill/i, "cost of living"],
];
const topicOf = (t: string) => RULES.find(([re]) => re.test(t))?.[1] ?? "other";
const DAY = 864e5;

// Socrata open-data portals: dataset, and which columns hold the type, the time, the location and the area.
type Src = { city: string; url: string; type: string; ts: string; lat?: string; lng?: string; area?: string; approx?: boolean };
const SOCRATA: Src[] = [
  { city: "seattle", url: "https://data.seattle.gov/resource/5ngg-rpne.json", type: "webintakeservicerequests", ts: "createddate", lat: "latitude", lng: "longitude", area: "community_reporting_area" },
  { city: "new york", url: "https://data.cityofnewyork.us/resource/erm2-nwe9.json", type: "complaint_type", ts: "created_date", lat: "latitude", lng: "longitude", area: "borough" },
  { city: "chicago", url: "https://data.cityofchicago.org/resource/v6vf-nfxy.json", type: "sr_type", ts: "created_date", lat: "latitude", lng: "longitude", area: "community_area" },
  { city: "san francisco", url: "https://data.sf.gov/resource/vw6y-z8j6.json", type: "service_name", ts: "requested_datetime", lat: "lat", lng: "long", area: "analysis_neighborhood" },
  { city: "austin", url: "https://datahub.austintexas.gov/resource/xwdj-i9he.json", type: "sr_type_desc", ts: "sr_created_date", lat: "sr_location_lat", lng: "sr_location_long", area: "sr_location_council_district" },
  { city: "calgary", url: "https://data.calgary.ca/resource/iahh-g8bj.json", type: "service_name", ts: "requested_date", lat: "latitude", lng: "longitude", area: "comm_name" },
  { city: "edmonton", url: "https://data.edmonton.ca/resource/q7ua-agfg.json", type: "service_description", ts: "date_created", lat: "nbhd_latitude", lng: "nbhd_longitude", area: "neighbourhood", approx: true },
];
const soql = (s: Src, p: Record<string, string>) =>
  fetch(s.url + "?" + new URLSearchParams(p), { headers: UA }).then((r) => r.ok ? r.json() : Promise.reject(new Error(s.city + " " + r.status)));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);

async function syncSocrata(s: Src) {
  const rows: any[] = [], pins: any[] = [];
  await Promise.all(Array.from({ length: 8 }, (_, d) => d).map(async (d) => {
    const day = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const lo = iso(Date.now() - (d + 1) * DAY), hi = iso(Date.now() - d * DAY);
    const r = await soql(s, { $select: `${s.type} as t, count(*) as n`, $where: `${s.ts} >= '${lo}' and ${s.ts} < '${hi}'`, $group: s.type, $limit: "500" });
    for (const x of r ?? []) if (x.t) rows.push({ city: s.city, day, rtype: String(x.t).slice(0, 80), topic: topicOf(String(x.t)), n: Number(x.n) });
  }));
  if (s.lat && s.lng) {
    const r = await soql(s, { $select: `${s.type} as t, ${s.ts} as ts, ${s.lat} as la, ${s.lng} as lo${s.area ? `, ${s.area} as ar` : ""}`,
      $where: `${s.lat} is not null and ${s.ts} >= '${iso(Date.now() - 7 * DAY)}'`, $order: `${s.ts} DESC`, $limit: "300" });
    for (const x of r ?? []) {
      let la = Number(x.la), lo = Number(x.lo); if (!isFinite(la) || !isFinite(lo) || !la || !lo) continue;
      if (s.approx) { la += (Math.random() - .5) * .004; lo += (Math.random() - .5) * .006; }   // neighbourhood centre only: spread the dots a little
      pins.push({ id: s.city + ":" + x.ts + ":" + Math.round(la * 1e4) + ":" + Math.round(lo * 1e4) + ":" + String(x.t).slice(0, 20), city: s.city,
        rtype: String(x.t).slice(0, 80), topic: topicOf(String(x.t)), lat: Math.round(la * 1e4) / 1e4, lng: Math.round(lo * 1e4) / 1e4,
        area: x.ar ? String(x.ar).slice(0, 60) : null, ts: new Date(x.ts + (String(x.ts).endsWith("Z") ? "" : "Z")).toISOString() });
    }
  }
  return { rows, pins };
}

// City of Vancouver (Opendatasoft, Open Government Licence - Vancouver)
const VAN = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/3-1-1-service-requests/records";
const vq = (params: Record<string, string>) => fetch(VAN + "?" + new URLSearchParams(params), { headers: UA }).then((r) => r.json());
async function syncVancouver() {
  const rows: any[] = [], pins: any[] = [];
  for (let d = 0; d < 8; d++) {
    const day = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const where = d === 0 ? "service_request_open_timestamp >= now(days=-1)" : `service_request_open_timestamp >= now(days=-${d + 1}) and service_request_open_timestamp < now(days=-${d})`;
    for (let off = 0; off < 400; off += 100) {
      const r = await vq({ select: "service_request_type, count(*) as n", where, group_by: "service_request_type", limit: "100", offset: String(off), order_by: "n desc" });
      for (const x of r.results ?? []) rows.push({ city: "vancouver", day, rtype: String(x.service_request_type).slice(0, 80), topic: topicOf(String(x.service_request_type)), n: Number(x.n) });
      if ((r.results ?? []).length < 100) break;
    }
  }
  for (let off = 0; off < 300; off += 100) {
    const r = await vq({ select: "service_request_type, local_area, latitude, longitude, service_request_open_timestamp", where: "geom is not null and service_request_open_timestamp >= now(days=-7)",
      order_by: "service_request_open_timestamp desc", limit: "100", offset: String(off) });
    for (const x of r.results ?? []) {
      if (x.latitude == null || x.longitude == null) continue;
      pins.push({ id: "vancouver:" + x.service_request_open_timestamp + ":" + Math.round(x.latitude * 1e4) + ":" + Math.round(x.longitude * 1e4) + ":" + String(x.service_request_type).slice(0, 20),
        city: "vancouver", rtype: String(x.service_request_type).slice(0, 80), topic: topicOf(String(x.service_request_type)),
        lat: Math.round(x.latitude * 1e4) / 1e4, lng: Math.round(x.longitude * 1e4) / 1e4, area: x.local_area, ts: x.service_request_open_timestamp });
    }
    if ((r.results ?? []).length < 100) break;
  }
  return { rows, pins };
}

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const report: Record<string, any> = {};
  const jobs: [string, Promise<{ rows: any[]; pins: any[] }>][] = [["vancouver", syncVancouver()], ...SOCRATA.map((s) => [s.city, syncSocrata(s)] as [string, Promise<any>])];
  for (const [city, job] of jobs) {
    try {   // one city failing never stops the others
      const { rows, pins } = await job;
      for (let i = 0; i < rows.length; i += 500) await db.from("city_reports").upsert(rows.slice(i, i + 500), { onConflict: "city,day,rtype" });
      if (pins.length) await db.from("city_pins").upsert(pins, { onConflict: "id", ignoreDuplicates: true });
      report[city] = { types: rows.length, pins: pins.length };
    } catch (e) { report[city] = { error: String((e as Error).message).slice(0, 120) }; }
  }
  await db.from("city_pins").delete().lt("ts", new Date(Date.now() - 14 * DAY).toISOString());
  const { data: bf, error: be } = await db.rpc("vp_official_backfill", { p_per_city: 40 });   // official reports onto the board as shared issues
  report.board = be ? { error: be.message } : bf;
  return new Response(JSON.stringify(report));
});
