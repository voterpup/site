// "What's broken on your block": official 3-1-1 reports near a spot, straight from each city's open-data portal, and Follow:
// we check followed reports every few hours and tell the follower when the City changes the status. We show only what the
// City publishes (type, status, dates, the block, never a house number) and add nothing but date arithmetic.
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const UA = { "User-Agent": "VoterPupBot/0.3 (+https://voterpup.com; hi@voterpup.com)" };
webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

type City = { key: string; name: string; url: string; source: string; site: string; id: string; type: string; sub?: string; status: string; opened: string; closed?: string; addr: string; geo: string; centre: [number, number] };
const CITIES: City[] = [
  { key: "san francisco", name: "San Francisco", url: "https://data.sf.gov/resource/vw6y-z8j6.json", source: "City and County of San Francisco 311 (DataSF)", site: "https://data.sf.gov/d/vw6y-z8j6",
    id: "service_request_id", type: "service_name", sub: "service_subtype", status: "status_description", opened: "requested_datetime", closed: "closed_date", addr: "address", geo: "point", centre: [37.7749, -122.4194] },
  { key: "seattle", name: "Seattle", url: "https://data.seattle.gov/resource/5ngg-rpne.json", source: "City of Seattle Customer Service Requests (data.seattle.gov)", site: "https://data.seattle.gov/d/5ngg-rpne",
    id: "servicerequestnumber", type: "webintakeservicerequests", status: "servicerequeststatusname", opened: "createddate", addr: "location", geo: "latitude_longitude", centre: [47.6062, -122.3321] },
  { key: "new york", name: "New York", url: "https://data.cityofnewyork.us/resource/erm2-nwe9.json", source: "NYC 311 Service Requests (NYC Open Data)", site: "https://data.cityofnewyork.us/d/erm2-nwe9",
    id: "unique_key", type: "complaint_type", sub: "descriptor", status: "status", opened: "created_date", closed: "closed_date", addr: "incident_address", geo: "location", centre: [40.7128, -74.006] },
  { key: "chicago", name: "Chicago", url: "https://data.cityofchicago.org/resource/v6vf-nfxy.json", source: "City of Chicago 311 Service Requests (Chicago Data Portal)", site: "https://data.cityofchicago.org/d/v6vf-nfxy",
    id: "sr_number", type: "sr_type", status: "status", opened: "created_date", closed: "closed_date", addr: "street_address", geo: "location", centre: [41.8781, -87.6298] },
];
const kmBetween = (a: [number, number], b: [number, number]) => { const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r; return Math.sqrt(x * x + y * y) * 6371; };
function cityFor(lat: number, lng: number): City | null { let best: City | null = null, d = 1e9; for (const c of CITIES) { const k = kmBetween([lat, lng], c.centre); if (k < d) { d = k; best = c; } } return d < 40 ? best : null; }
const cityByKey = (k: string) => CITIES.find((c) => c.key === k) ?? null;
const title = (s: string) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bSt\b/g, "St").trim();
// "1510 MARKET ST, SAN FRANCISCO, CA 94102" -> "1500 block of Market St"; intersections stay as they are; never a house number
function blockOf(a: string): string {
  let s = String(a || "").split(",")[0].replace(/\bVirtual\b/i, "").trim();
  if (!s) return "";
  if (/&|\band\b|\/| at /i.test(s)) return title(s);
  const m = s.match(/^(\d+)[A-Z-]*\s+(.+)$/i);
  return m ? Math.floor(Number(m[1]) / 100) * 100 + " block of " + title(m[2]) : title(s);
}
const soql = (c: City, p: Record<string, string>) => fetch(c.url + "?" + new URLSearchParams(p), { headers: UA }).then(async (r) => { if (!r.ok) throw new Error(c.key + " " + r.status + " " + (await r.text()).slice(0, 120)); return r.json(); });
const days = (a?: string, b?: string) => { if (!a) return null; const t0 = Date.parse(a + (a.endsWith("Z") ? "" : "Z")), t1 = b ? Date.parse(b + (b.endsWith("Z") ? "" : "Z")) : Date.now(); return isFinite(t0) && isFinite(t1) ? Math.max(0, Math.round((t1 - t0) / 864e5)) : null; };
const isClosed = (s: string) => /closed|completed|resolved|canceled|cancelled/i.test(s || "");
async function logFail(db: any, msg: unknown) { try { await db.from("svc_errors").insert({ svc: "block", msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* never block */ } }

function shape(c: City, x: any, at?: [number, number]) {
  const opened = x[c.opened], closed = c.closed ? x[c.closed] : undefined, st = String(x[c.status] || "");
  const g = x[c.geo], la = g?.coordinates ? Number(g.coordinates[1]) : Number(g?.latitude), lo = g?.coordinates ? Number(g.coordinates[0]) : Number(g?.longitude);
  return { id: String(x[c.id]), city: c.key, type: title(x[c.type]), sub: c.sub && x[c.sub] ? title(x[c.sub]) : null, status: st || "Unknown", closed: isClosed(st),
    opened, closedAt: closed || null, age: days(opened), took: closed ? days(opened, closed) : null, block: blockOf(x[c.addr]),
    lat: isFinite(la) ? Math.round(la * 1e3) / 1e3 : null, lng: isFinite(lo) ? Math.round(lo * 1e3) / 1e3 : null,
    km: at && isFinite(la) ? Math.round(kmBetween(at, [la, lo]) * 100) / 100 : null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { /* cron sends {} */ }
  const tail = String(b.tail || "");

  if (b.action === "near") {   // reports within r metres of a spot, last 30 days
    const lat = Number(b.lat), lng = Number(b.lng), r = Math.min(1500, Math.max(150, Number(b.r) || 500));
    if (!isFinite(lat) || !isFinite(lng)) return json({ error: "Pick a spot first." }, 400);
    const c = cityFor(lat, lng);
    if (!c) return json({ covered: false, cities: CITIES.map((x) => x.name) });
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19), where = `within_circle(${c.geo}, ${lat}, ${lng}, ${r}) AND ${c.opened} > '${since}'`;
    try {
      const sel = [c.id, c.type, c.sub, c.status, c.opened, c.closed, c.addr, c.geo].filter(Boolean).join(",");
      const [rows, counts] = await Promise.all([
        soql(c, { $select: sel, $where: where, $order: `${c.opened} DESC`, $limit: "80" }),
        soql(c, { $select: `${c.status} as s, count(*) as n`, $where: where, $group: c.status, $limit: "50" }),
      ]);
      let open = 0, closed = 0; for (const x of counts) { if (isClosed(x.s)) closed += Number(x.n); else open += Number(x.n); }
      const list = rows.map((x: any) => shape(c, x, [lat, lng]));
      const byType: Record<string, number> = {}; for (const x of list) byType[x.type] = (byType[x.type] || 0) + 1;
      const tooks = list.filter((x: any) => x.took != null).map((x: any) => x.took).sort((a: number, b2: number) => a - b2);
      let follows: string[] = [];
      if (tail) { const { data } = await db.from("block_follows").select("report_id").eq("tail", tail).eq("city", c.key); follows = (data ?? []).map((x: any) => x.report_id); }
      return json({ covered: true, city: c.key, cityName: c.name, source: c.source, site: c.site, r, total: open + closed, open, closed,
        medianDays: tooks.length >= 5 ? tooks[Math.floor(tooks.length / 2)] : null, top: Object.entries(byType).sort((a, b2) => b2[1] - a[1]).slice(0, 4).map(([t, n]) => ({ type: t, n })),
        list, follows });
    } catch (e) { await logFail(db, e); return json({ error: "The City's data didn't answer just now. Try again in a minute." }, 502); }
  }

  if (b.action === "follow" || b.action === "unfollow") {
    if (!tail || !(await db.from("ledgers").select("tail").eq("tail", tail).maybeSingle()).data) return json({ error: "no pup" }, 400);
    const c = cityByKey(String(b.city || "")); const id = String(b.id || "").slice(0, 40);
    if (!c || !id) return json({ error: "bad report" }, 400);
    if (b.action === "unfollow") { await db.from("block_follows").delete().eq("tail", tail).eq("city", c.key).eq("report_id", id); return json({ ok: true }); }
    const { count } = await db.from("block_follows").select("report_id", { count: "exact", head: true }).eq("tail", tail);
    if ((count ?? 0) >= 50) return json({ error: "You're following 50 already. Unfollow one first." }, 429);
    try {
      const r = await soql(c, { $select: [c.id, c.type, c.sub, c.status, c.opened, c.closed, c.addr].filter(Boolean).join(","), $where: `${c.id} = '${id.replace(/'/g, "")}'`, $limit: "1" });
      if (!r.length) return json({ error: "The City has no report with that number." }, 404);
      const s = shape(c, r[0]);
      await db.from("block_follows").upsert({ tail, city: c.key, report_id: s.id, rtype: s.type + (s.sub && s.sub !== s.type ? " · " + s.sub : ""), block: s.block, opened: s.opened, last_status: s.status }, { onConflict: "tail,city,report_id" });
      return json({ ok: true, report: s });
    } catch (e) { await logFail(db, e); return json({ error: "Couldn't reach the City's data. Try again." }, 502); }
  }

  if (b.action === "mine") {
    if (!tail) return json([]);
    const { data } = await db.from("block_follows").select("city, report_id, rtype, block, opened, last_status, changed_at, created_at").eq("tail", tail).order("created_at", { ascending: false }).limit(50);
    return json(data ?? []);
  }

  // cron: check every followed report that is still open; tell followers when the City changes its status
  if (b.action === "check" || !b.action) {
    const { data: open } = await db.from("block_follows").select("tail, city, report_id, rtype, block, opened, last_status").limit(2000);
    const pending = (open ?? []).filter((f: any) => !isClosed(f.last_status));
    let changed = 0;
    for (const c of CITIES) {
      const mine = pending.filter((f: any) => f.city === c.key); if (!mine.length) continue;
      const ids = [...new Set(mine.map((f: any) => f.report_id))];
      for (let i = 0; i < ids.length; i += 80) {
        try {
          const chunk = ids.slice(i, i + 80);
          const rows = await soql(c, { $select: [c.id, c.status, c.opened, c.closed].filter(Boolean).join(","), $where: `${c.id} in (${chunk.map((x) => "'" + String(x).replace(/'/g, "") + "'").join(",")})`, $limit: "100" });
          for (const x of rows) {
            const st = String(x[c.status] || ""), id = String(x[c.id]);
            for (const f of mine.filter((m: any) => m.report_id === id && m.last_status !== st)) {
              changed++;
              await db.from("block_follows").update({ last_status: st, changed_at: new Date().toISOString() }).eq("tail", f.tail).eq("city", c.key).eq("report_id", id);
              const took = isClosed(st) ? days(x[c.opened], c.closed ? x[c.closed] : undefined) : null;
              const line = isClosed(st) ? `Closed by the City${took != null ? " · " + took + " day" + (took === 1 ? "" : "s") + " after it was reported" : ""}` : `The City changed it to: ${st}`;
              const head = `${f.rtype} · ${f.block || c.name}`;
              const { data: subs } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("tail", f.tail);
              for (const s of subs ?? []) webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: "🐾 " + head, body: line, url: "/block?f=1" }), { TTL: 12 * 3600 }).catch(() => {});
              const { data: m } = await db.from("mail_subs").select("email, token").eq("tail", f.tail).eq("follows", true).is("unsub_at", null).limit(1).maybeSingle();
              const key = Deno.env.get("RESEND_API_KEY");
              if (m && key) {
                const unsub = `https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/send-mail?unsub=${m.token}`, link = `https://voterpup.com/p/?k=${f.tail}&go=block`;
                const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#1d2433"><p style="font-size:20px;margin:0 0 6px">🐾 ${head.replace(/</g, "&lt;")}</p><p style="font-size:16px;line-height:1.5">${line}.</p><p><a href="${link}" style="display:inline-block;background:#e8b84b;color:#2a2418;font-weight:800;padding:12px 18px;border-radius:999px;text-decoration:none">See your block</a></p><p style="font-size:12px;color:#6b7387;margin-top:28px">Status from ${c.source}, as the City publishes it. You followed this report on VoterPup. The button opens your pup, so keep this email to yourself. <a href="${unsub}" style="color:#6b7387">Unsubscribe</a></p></div>`;
                fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
                  body: JSON.stringify({ from: "VoterPup <pup@voterpup.com>", to: [m.email], subject: "🐾 " + head + ": " + (isClosed(st) ? "closed by the City" : st), html, text: `${head}\n${line}.\nSee your block: ${link}\nUnsubscribe: ${unsub}`, headers: { "List-Unsubscribe": `<${unsub}>` } }) }).catch(() => {});
              }
            }
          }
        } catch (e) { await logFail(db, e); }
      }
    }
    return json({ checked: pending.length, changed });
  }
  return json({ error: "bad action" }, 400);
});
