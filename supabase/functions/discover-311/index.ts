// Finds open 3-1-1 data for cities people look at (city_wanted), and switches a source on only when its recent,
// located reports really fall inside that city's boundary. Hourly. POST {"place":"Dallas, Texas, United States"} to try one now.
import { createClient } from "npm:@supabase/supabase-js@2";
const UA = { "User-Agent": "VoterPupBot/0.2 (+https://voterpup.com; hi@voterpup.com)" };
const DAY = 864e5;
const KNOWN = ["vancouver", "seattle", "new york", "chicago", "san francisco", "austin", "calgary", "edmonton"];   // built into sync-311
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const getJSON = (u: string) => fetch(u, { headers: UA }).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.status + " " + u.slice(0, 80))));

const pick = (cols: { n: string; t: string }[], t: RegExp, good: RegExp, bad?: RegExp) =>
  cols.filter((c) => t.test(c.t) && good.test(c.n) && !(bad && bad.test(c.n)) && !c.n.startsWith(":"))
      .sort((a, b) => score(b.n, good) - score(a.n, good))[0]?.n;
const score = (n: string, re: RegExp) => (n.match(re)?.[0].length ?? 0) * 10 - n.length;

async function geocode(place: string) {
  // Photon (OpenStreetMap data); Nominatim refuses cloud servers. extent = [west, north, east, south]
  const r = await getJSON("https://photon.komoot.io/api/?limit=1&layer=city&q=" + encodeURIComponent(place)).catch(() => null);
  const f = r?.features?.[0]; if (!f || !f.properties?.extent) return null;
  const [w0, n0, e0, s0] = f.properties.extent.map(Number), padLat = (n0 - s0) * .15, padLng = (e0 - w0) * .15;
  return { s: s0 - padLat, n: n0 + padLat, w: w0 - padLng, e: e0 + padLng, kind: f.properties.type, name: f.properties.name };
}

async function candidates(city: string) {
  // 1. which open-data portals belong to this city? (the domains that publish the most datasets about it)
  const near = await getJSON("https://api.us.socrata.com/api/catalog/v1?only=datasets&limit=50&q=" + encodeURIComponent('"' + city + '"')).catch(() => ({ results: [] }));
  const tally = new Map<string, number>();
  for (const x of near.results ?? []) {
    const d = x.metadata.domain, a = String(x.resource.attribution || "") + " " + d;
    if (new RegExp(city.split(/\s+/)[0], "i").test(a) || new RegExp(city, "i").test(String(x.resource.name || ""))) tally.set(d, (tally.get(d) ?? 0) + 1);
  }
  const domains = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  // 2. 311 datasets on those portals, plus a general search
  const urls = [
    ...domains.flatMap((d) => ["311", "service requests"].map((q) => `https://api.us.socrata.com/api/catalog/v1?only=datasets&limit=20&domains=${d}&q=${encodeURIComponent(q)}`)),
    ...[`${city} 311`, `${city} service requests`].map((q) => "https://api.us.socrata.com/api/catalog/v1?only=datasets&limit=20&q=" + encodeURIComponent(q)),
  ];
  const seen = new Map<string, any>();
  for (const u of urls) {
    const r = await getJSON(u).catch(() => ({ results: [] }));
    for (const x of r.results ?? []) {
      const res = x.resource, name = String(res.name || "") + " " + String(res.description || "").slice(0, 300);
      if (!/311|service request|request for service|customer service/i.test(name)) continue;
      if (Date.now() - new Date(res.data_updated_at || 0).getTime() > 45 * DAY) continue;   // must be live
      const cols = (res.columns_field_name || []).map((n: string, i: number) => ({ n, t: String(res.columns_datatype?.[i] || "") }));
      seen.set(res.id, { id: res.id, domain: x.metadata.domain, name: res.name, cols });
    }
  }
  return [...seen.values()];
}

// a location as a GeoJSON point, a Socrata location, or text like "(32.84, -96.63)"
function parsePt(v: any): { la: number; lo: number } {
  if (v && typeof v === "object") {
    if (Array.isArray(v.coordinates)) return { la: Number(v.coordinates[1]), lo: Number(v.coordinates[0]) };
    if (v.latitude != null) return { la: Number(v.latitude), lo: Number(v.longitude) };
  }
  const m = String(v ?? "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  return m ? { la: Number(m[1]), lo: Number(m[2]) } : { la: NaN, lo: NaN };
}

async function tryOne(c: any, box: any) {
  const ts = pick(c.cols, /date/i, /creat|open|request|report|receiv|submit|date/i, /clos|due|updat|resol|complet|modif|status/i);
  const type = pick(c.cols, /text/i, /sr_type|request_type|service_name|service_request_type|complaint_type|type|category|problem|issue|service|description|subject/i,
                    /status|address|street|city|zip|state|method|channel|source|department|agency|number|_id$|^id$|resolution|owner|council|ward|district|location/i);
  const lat = pick(c.cols, /number|text/i, /^lat$|^latitude$|_lat$|latitude/i), lng = pick(c.cols, /number|text/i, /^lon$|^lng$|^long$|^longitude$|_long$|_lng$|longitude/i);
  const point = !lat || !lng ? (pick(c.cols, /point|location/i, /location|geom|point|the_geom|coordinates|lat/i) || pick(c.cols, /text/i, /lat_?loc|latlong|lat_long|lat_lon|geo_?loc/i)) : undefined;
  const area = pick(c.cols, /text/i, /neighbo|community|borough|district|ward|area|council/i, /address/i);
  if (!ts || !type || (!(lat && lng) && !point)) return { ok: false, why: "columns not recognised" };
  const url = `https://${c.domain}/resource/${c.id}.json`;
  const q = (p: Record<string, string>) => getJSON(url + "?" + new URLSearchParams(p));
  const sel = lat && lng ? `${lat} as la, ${lng} as lo` : `${point} as pt`;
  const where = `${ts} >= '${iso(Date.now() - 14 * DAY)}' and ${lat && lng ? lat + " is not null" : point + " is not null"}`;
  const rows = await q({ $select: `${type} as t, ${sel}`, $where: where, $order: `${ts} DESC`, $limit: "200" }).catch((e) => { throw new Error("query: " + e.message); });
  const pts = (rows ?? []).map((r: any) => r.pt !== undefined ? { ...parsePt(r.pt), t: r.t } : { la: Number(r.la), lo: Number(r.lo), t: r.t })
                          .filter((p: any) => isFinite(p.la) && isFinite(p.lo) && p.la && p.lo);
  if (pts.length < 30) return { ok: false, why: `only ${pts.length} located reports in 14 days` };
  const inside = pts.filter((p: any) => p.la >= box.s && p.la <= box.n && p.lo >= box.w && p.lo <= box.e).length / pts.length;
  const kinds = new Set(pts.map((p: any) => String(p.t))).size;
  if (inside < .8) return { ok: false, why: `only ${Math.round(inside * 100)}% of reports inside the city`, inside };
  if (kinds < 3) return { ok: false, why: "fewer than 3 kinds of report", inside };
  return { ok: true, inside, src: { url, type_col: type, ts_col: ts, lat_col: lat ?? null, lng_col: lng ?? null, point_col: point ?? null, area_col: area ?? null }, name: c.name, domain: c.domain };
}

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: { place?: string } = {}; try { body = await req.json(); } catch (_) { /* cron */ }
  let todo: { city: string; place: string }[] = [];
  if (body.place) todo = [{ city: body.place.split(",")[0].trim().toLowerCase(), place: body.place }];
  else {
    const { data: srcs } = await db.from("city_sources").select("city, status, checked_at");
    const skip = new Set([...KNOWN, ...(srcs ?? []).filter((s: any) => s.status === "active" || Date.now() - new Date(s.checked_at).getTime() < 7 * DAY).map((s: any) => s.city)]);
    const { data: w } = await db.from("city_wanted").select("city, place, asks").order("asks", { ascending: false }).limit(20);
    todo = (w ?? []).filter((x: any) => !skip.has(x.city)).slice(0, 3).map((x: any) => ({ city: x.city, place: x.place || x.city }));
  }
  const out: any[] = [];
  for (const t of todo) {
    let result: any = { city: t.city };
    try {
      const box = await geocode(t.place);
      if (!box) throw new Error("couldn't find the place");
      const cands = await candidates(box.name || t.city);
      let best: any = null; const tried: string[] = [];
      for (const c of cands.slice(0, 8)) {
        const r = await tryOne(c, box).catch((e) => ({ ok: false, why: e.message }));
        tried.push(`${c.domain}/${c.id}: ${r.ok ? "OK " + Math.round(r.inside * 100) + "% inside" : r.why}`);
        if (r.ok && (!best || r.inside > best.inside)) best = r;
      }
      if (best) {
        const { error: ue } = await db.from("city_sources").upsert({ city: t.city, place: t.place, kind: "socrata", ...best.src, status: "active", inside: Math.round(best.inside * 100),
          note: `${best.domain} · ${best.name}`.slice(0, 200), checked_at: new Date().toISOString(), added_at: new Date().toISOString() });
        if (ue) throw new Error("saving the source: " + ue.message);
        result = { ...result, active: best.domain + " · " + best.name, inside: Math.round(best.inside * 100) + "%", tried };
      } else {
        await db.from("city_sources").upsert({ city: t.city, place: t.place, status: "none", note: (cands.length ? tried.join(" | ") : "no open 3-1-1 dataset found").slice(0, 900), checked_at: new Date().toISOString() });
        result = { ...result, active: null, tried: cands.length ? tried : ["no open 3-1-1 dataset found"] };
      }
    } catch (e) { result.error = String((e as Error).message).slice(0, 200); }
    await db.from("city_wanted").update({ tried_at: new Date().toISOString() }).eq("city", t.city);
    out.push(result);
  }
  return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json" } });
});
