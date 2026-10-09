// The founder's numbers page: /functions/v1/report?key=... (key lives in Supabase secrets). Plain HTML, phone-sized.
import { createClient } from "npm:@supabase/supabase-js@2";
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== Deno.env.get("REPORT_KEY")) return new Response("no", { status: 403 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const days = Math.min(60, Number(url.searchParams.get("days") || 14));
  const { data, error } = await db.rpc("vp_metrics", { p_days: days });
  if (error) return new Response(error.message, { status: 500 });
  const rows = (data ?? []) as any[];
  if (url.searchParams.get("myspot") === "1") {   // My spot numbers: by day, by shop, subscribers
    const since = new Date(Date.now() - days * 864e5).toISOString(), day = (ts: string) => new Date(new Date(ts).getTime() - 7 * 3600e3).toISOString().slice(0, 10);   // Pacific-ish day
    const { data: ev } = await db.from("events").select("ts, dev, meta, src").eq("event", "spot").gt("ts", since).limit(20000);
    const { data: finds } = await db.from("spot_finds").select("spot_id, finder_uid, created_at").gt("created_at", since).limit(20000);
    const { data: spots } = await db.from("spots").select("id, code, kind, place_name, place_code, visibility, created_at, owner_email").limit(5000);
    const { data: subs } = await db.from("spot_subs").select("kind, created_at, unsub_at").limit(5000);
    const byDay: Record<string, any> = {}; const D = (d: string) => (byDay[d] ??= { day: d, visitors: new Set(), map: 0, peeks: 0, places_viewed: 0, opens: 0, memories: 0, shops: 0, signins: 0, subs: 0, shares: 0 });
    for (const e of ev ?? []) { const d = D(day(e.ts)), st = e.meta?.step; d.visitors.add(e.dev); if (st === "map") d.map++; if (st === "peek") d.peeks++; if (st === "place") d.places_viewed++; if (st === "signin") d.signins++; if (st === "share") d.shares++; }
    for (const f of finds ?? []) D(day(f.created_at)).opens++;
    for (const s of spots ?? []) if (s.created_at > since) { const d = D(day(s.created_at)); if (s.kind === "place") d.shops++; else d.memories++; }
    for (const s of subs ?? []) if (s.created_at > since) D(day(s.created_at)).subs++;
    const daysOut = Object.values(byDay).map((d: any) => ({ ...d, visitors: d.visitors.size })).sort((x: any, y: any) => x.day < y.day ? 1 : -1);
    const idToPlace = new Map((spots ?? []).filter((s: any) => s.kind === "place").map((s: any) => [s.id, s]));
    const { data: allFinds } = await db.from("spot_finds").select("spot_id, finder_uid, created_at").limit(50000);
    const shops = (spots ?? []).filter((s: any) => s.kind === "place").map((p: any) => {
      const fs = (allFinds ?? []).filter((f: any) => f.spot_id === p.id), wk = fs.filter((f: any) => f.created_at > since).length;
      const uniq = new Set(fs.map((f: any) => f.finder_uid || "anon")).size, cnt: Record<string, number> = {}; for (const f of fs) if (f.finder_uid) cnt[f.finder_uid] = (cnt[f.finder_uid] || 0) + 1;
      const mem = (spots ?? []).filter((s: any) => s.place_code === p.code);
      return { shop: p.place_name, code: p.code, created: p.created_at, owner_email: !!p.owner_email, opens_total: fs.length, opens_period: wk, unique: uniq, repeat: Object.values(cnt).filter((n) => n > 1).length, memories: mem.length, memories_period: mem.filter((s: any) => s.created_at > since).length };
    }).sort((a: any, b: any) => b.opens_total - a.opens_total);
    const totals = { memories: (spots ?? []).filter((s: any) => s.kind !== "place").length, shops: shops.length, public: (spots ?? []).filter((s: any) => s.visibility === "public" && s.kind !== "place").length, subs_active: (subs ?? []).filter((s: any) => !s.unsub_at).length, subs_memory: (subs ?? []).filter((s: any) => !s.unsub_at && s.kind === "my_memory").length, subs_place: (subs ?? []).filter((s: any) => !s.unsub_at && s.kind === "place_new").length };
    return new Response(JSON.stringify({ days: daysOut, shops, totals }), { headers: { "content-type": "application/json", "cache-control": "no-store", "Access-Control-Allow-Origin": "https://voterpup.com" } });
  }
  if (url.searchParams.get("json") === "1") {
    const { data: recent } = await db.rpc("vp_recent_pups", { p_n: 40 });
    const { data: spend2 } = await db.from("discovery_log").select("cost_usd").gte("run_at", new Date(Date.now() - 7 * 864e5).toISOString());
    return new Response(JSON.stringify({ days: rows, recent: recent ?? [], spend7: (spend2 ?? []).reduce((t: number, r: any) => t + Number(r.cost_usd), 0) }),
      { headers: { "content-type": "application/json", "cache-control": "no-store", "Access-Control-Allow-Origin": "https://voterpup.com" } });
  }
  const { data: spend } = await db.from("discovery_log").select("cost_usd").gte("run_at", new Date(Date.now() - 7 * 864e5).toISOString());
  const week = (spend ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd), 0);
  const cols = [["day", "Day"], ["opens", "Opens"], ["pups", "Pups"], ["pups_booth", "booth"], ["issues", "Issues"], ["shared", "shared"], ["reminders_on", "Rem on"], ["installs", "Inst"], ["notif_opens", "Notif→"], ["swipes", "Swipes"], ["backs", "🐾"], ["d1", "D1%"], ["d1_rem", "D1 rem"], ["d1_norem", "D1 no"], ["d7", "D7%"]];
  const td = (v: any) => v === null || v === undefined ? "–" : String(v);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VoterPup numbers</title>
<style>body{font-family:system-ui,sans-serif;margin:12px;color:#1d2433}h1{font-size:18px;margin:0 0 4px}p{color:#5b6579;font-size:12px;margin:0 0 10px}
table{border-collapse:collapse;font-size:12px;width:100%}th,td{padding:5px 4px;border-bottom:1px solid #e6e9f0;text-align:right;white-space:nowrap}th{background:#f1f3f8;position:sticky;top:0}td:first-child,th:first-child{text-align:left}
.wrap{overflow-x:auto}.k{background:#fff8e6}</style>
<h1>🐾 VoterPup numbers</h1><p>Vancouver days · D1 = came back the next day (rem = reminders on, no = off) · API spend last 7 days: $${week.toFixed(2)}</p>
<div class="wrap"><table><tr>${cols.map((c) => `<th${c[0].startsWith("d1") ? ' class="k"' : ""}>${c[1]}</th>`).join("")}</tr>
${rows.map((r) => `<tr>${cols.map((c) => `<td${c[0].startsWith("d1") ? ' class="k"' : ""}>${td(c[0] === "day" ? String(r.day).slice(5) : r[c[0]])}</td>`).join("")}</tr>`).join("")}</table></div>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});
