// Mails the founder (ALERT_TO, default hi@voterpup.com) when, since the last run: a Claude call failed, or a pup was
// made by someone who arrived through an ad link (?src=yt*/ig*). Runs every 30 minutes from pg_cron; POST {test:true} to force a mail.
import { createClient } from "npm:@supabase/supabase-js@2";
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const when = (ts: string) => new Date(ts).toLocaleString("en-CA", { timeZone: "America/Vancouver", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {}; try { body = await req.json(); } catch (_) { /* cron */ }
  const to = Deno.env.get("ALERT_TO") || "hi@voterpup.com";
  const { data: st } = await db.from("alert_state").select("val").eq("key", "founder").maybeSingle();
  const since = body.since || st?.val || new Date(Date.now() - 36e5).toISOString(), now = new Date().toISOString();

  const { data: errs } = await db.from("svc_errors").select("ts, svc, msg").gt("ts", since).order("ts", { ascending: false }).limit(50);
  const { data: internal } = await db.from("internal_devs").select("dev");
  const mine = new Set((internal ?? []).map((d: any) => d.dev));
  const { data: made } = await db.from("events").select("ts, src, tail, dev").eq("event", "pup_created").gt("ts", since).order("ts");
  const adPups = (made ?? []).filter((e: any) => /^(yt|ig)\d/.test(String(e.src || "")) && !mine.has(e.dev));
  const tails = adPups.map((e: any) => e.tail).filter(Boolean);
  const { data: names } = tails.length ? await db.from("ledgers").select("tail, name").in("tail", tails) : { data: [] as any[] };
  const { data: firsts } = tails.length ? await db.from("entries").select("tail, body").in("tail", tails).order("created_at") : { data: [] as any[] };
  const nameOf = new Map((names ?? []).map((n: any) => [n.tail, n.name])), issueOf = new Map<string, string>();
  for (const e of firsts ?? []) if (!issueOf.has(e.tail)) issueOf.set(e.tail, e.body);
  const { data: opens } = await db.from("events").select("src, dev").eq("event", "open").gt("ts", since).or("src.like.yt%,src.like.ig%");
  const visits: Record<string, Set<string>> = {};
  for (const o of opens ?? []) if (!mine.has(o.dev)) (visits[o.src] ??= new Set()).add(o.dev);

  if (!errs?.length && !adPups.length && !body.test) { await db.from("alert_state").upsert({ key: "founder", val: now }); return json({ sent: false, since }); }

  const parts: string[] = [];
  if (errs?.length) parts.push(`⚠️ ${errs.length} AI call failure${errs.length === 1 ? "" : "s"}`);
  if (adPups.length) parts.push(`🐾 ${adPups.length} new pup${adPups.length === 1 ? "" : "s"} from ads`);
  const subject = (parts.join(" · ") || "VoterPup check-in") + (body.test ? " (test)" : "");
  let html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a2430;max-width:560px">`;
  if (adPups.length) {
    html += `<h2 style="margin:0 0 8px">🐾 New pups from ads</h2><table style="border-collapse:collapse;width:100%">` +
      adPups.map((e: any) => `<tr><td style="padding:6px 8px 6px 0;color:#667">${when(e.ts)}</td><td style="padding:6px 8px"><b>${esc(nameOf.get(e.tail) ?? "?")}</b></td><td style="padding:6px 8px">${esc(issueOf.get(e.tail) ?? "—")}</td><td style="padding:6px 0;color:#667">${esc(e.src)}</td></tr>`).join("") + `</table>`;
  }
  const vis = Object.keys(visits).sort().map((k) => `${k}: ${visits[k].size}`).join(" · ");
  if (vis) html += `<p style="color:#667;margin:8px 0 16px">Ad visitors in the same window: ${esc(vis)}</p>`;
  if (errs?.length) {
    html += `<h2 style="margin:16px 0 8px">⚠️ AI call failures</h2>` +
      errs.map((x: any) => `<div style="padding:6px 0;border-top:1px solid #e3e7ee"><span style="color:#667">${when(x.ts)}</span> · <b>${esc(x.svc)}</b><br><code style="font-size:13px">${esc(x.msg)}</code></div>`).join("");
  }
  if (body.test && !errs?.length && !adPups.length) html += `<p>This is a test. Nothing new since ${when(since)}.</p>`;
  html += `<p style="color:#99a;font-size:12px;margin-top:20px">Window: ${when(since)} → ${when(now)} · <a href="https://voterpup.com/numbers.html">numbers</a></p></div>`;

  const send = (from: string) => fetch("https://api.resend.com/emails", { method: "POST",
    headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }) });
  let r = await send("VoterPup <pup@voterpup.com>"); if (r.status === 403 || r.status === 422) r = await send("VoterPup <onboarding@resend.dev>");
  const ok = r.ok, detail = ok ? "" : (await r.text()).slice(0, 200);
  if (ok || !body.test) await db.from("alert_state").upsert({ key: "founder", val: now });
  return json({ sent: ok, to, subject, errors: errs?.length ?? 0, pups: adPups.length, detail });
});
