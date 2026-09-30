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
