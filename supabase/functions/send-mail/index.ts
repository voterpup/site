// Reports by email: the 7 pm pulse and the vote-morning Flashback, for phones that can't take notifications.
// Cron every 15 min. GET ?unsub=TOKEN unsubscribes (link in every mail). POST {test:"you@x"} with the report key sends a sample.
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://voterpup.com";
const FN = "https://setyjmgijsbplgyqynlh.supabase.co/functions/v1/send-mail";
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function sendMail(to: string, subject: string, html: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not set");
  const attempt = async (from: string) => fetch("https://api.resend.com/emails", { method: "POST",
    headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text, headers: { "List-Unsubscribe": `<${html.match(/href="([^"]*unsub=[^"]*)"/)?.[1] ?? SITE}>` } }) });
  let r = await attempt("VoterPup <pup@voterpup.com>");
  if (r.status === 403 || r.status === 422) r = await attempt("VoterPup <onboarding@resend.dev>");   // domain not verified yet: test mode
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 200));
  return r.status;
}
function wrap(name: string, body: string, cta: string, url: string, unsub: string) {
  return { html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#1d2433">
<p style="font-size:22px;margin:0 0 6px">🐾 ${esc(name)}</p><p style="font-size:16px;line-height:1.5">${esc(body)}</p>
<p><a href="${url}" style="display:inline-block;background:#e8b84b;color:#2a2418;font-weight:800;padding:12px 18px;border-radius:999px;text-decoration:none">${esc(cta)}</a></p>
<p style="font-size:12px;color:#6b7387;margin-top:28px">You asked ${esc(name)} to report back by email. VoterPup Technologies Inc., Vancouver, BC · <a href="${unsub}" style="color:#6b7387">Unsubscribe</a> · <a href="${SITE}/privacy.html" style="color:#6b7387">Privacy</a></p></div>`,
    text: `${name}\n\n${body}\n\n${cta}: ${url}\n\nUnsubscribe: ${unsub}` };
}
const LINES = [(n: string) => `Anything they should fix today? ${n} is listening.`, (n: string) => `Saw something that needs fixing? Tell ${n}. Five words is plenty.`];

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (req.method === "GET" && url.searchParams.get("unsub")) {
    const tok = url.searchParams.get("unsub")!.replace(/[^a-f0-9]/g, "");
    await db.from("mail_subs").update({ unsub_at: new Date().toISOString() }).eq("token", tok);
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>Unsubscribed 🐾</h2><p>No more emails from your pup. Your pup and your issues are untouched.</p><p><a href="${SITE}/app.html">Open VoterPup</a></p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  let body: { test?: string; key?: string } = {};
  try { body = await req.json(); } catch (_) { /* cron */ }
  const line = (f: any, name: string) => {
    const st = f?.stats ?? {};
    if (f?.top?.rank && f.top.rank <= 5) return `“${String(f.top.body || "your photo").slice(0, 40)}” is #${f.top.rank}${f.top.city ? " in " + f.top.city : ""} this week. Anything new today?`;
    if ((f?.backs ?? 0) > 0) return `${f.backs} ${f.backs === 1 ? "person feels" : "people feel"} the same as you so far. Anything new today?`;
    if (f?.city && ((f.today?.issues ?? 0) >= 2 || (f.city_reports?.n ?? 0) >= 20)) return `Today in ${f.city}: ` + ((f.today?.issues ?? 0) ? `${f.today.issues} issues from ${f.today.pups} people` : "") +
      ((f.today?.issues ?? 0) && (f.city_reports?.n ?? 0) ? " + " : "") + ((f.city_reports?.n ?? 0) ? `${f.city_reports.n} 3-1-1 reports` : "") +
      ((f.today?.top_topic || f.city_reports?.top_topic) ? `, most on #${f.today?.top_topic || f.city_reports.top_topic}` : "") + `. Anything to add?`;
    if (f?.city && (st.issues_week ?? 0) >= 3) return `This week in ${f.city}: ${st.issues_week} issues from ${st.pups_week} people` + (st.top_topic ? `, most on #${st.top_topic}` : "") + `. Anything to add?`;
    return LINES[Math.floor(Math.random() * LINES.length)](name);
  };
  if (body.test) {
    if (body.key !== Deno.env.get("REPORT_KEY")) return new Response("no", { status: 403 });
    const m = wrap("Oreo", "Today in Vancouver: 14 issues from 10 people, most on #transit. Anything to add?", "Tell Oreo", SITE + "/app.html?add=1", FN + "?unsub=test");
    try { const st = await sendMail(body.test, "🐾 Oreo's report: today in Vancouver", m.html, m.text); return new Response(JSON.stringify({ sent: st })); }
    catch (e) { return new Response(JSON.stringify({ error: String((e as Error).message) }), { status: 200 }); }
  }
  let sent = 0, failed = 0, votes = 0;
  const { data: due } = await db.rpc("vp_due_mails");
  for (const s of due ?? []) {
    const { data: f } = await db.rpc("vp_reminder_facts", { p_tail: s.tail });
    const text = line(f, s.name);
    const m = wrap(s.name, text, "Tell " + s.name, `${SITE}/p/${s.tail}?add=1`, `${FN}?unsub=${s.token}`);
    try { await sendMail(s.email, `🐾 ${s.name}: ${text.slice(0, 60)}`, m.html, m.text); await db.from("mail_subs").update({ last_sent: new Date().toISOString(), fails: 0 }).eq("email", s.email); sent++; }
    catch (e) { console.log("mail fail", String((e as Error).message).slice(0, 120)); await db.from("mail_subs").update({ fails: s.fails + 1 }).eq("email", s.email); failed++; }
  }
  const { data: vd } = await db.rpc("vp_due_vote_mails");
  for (const v of vd ?? []) {
    const m = wrap(v.name, `Today you vote${v.city ? " in " + v.city : ""}. ${v.election}. ${v.name} has your Flashback ready.`, "Open my Flashback", `${SITE}/p/${v.tail}?flash=1`, `${FN}?unsub=${v.token}`);
    try { await sendMail(v.email, `🗳️ Today you vote${v.city ? " in " + v.city : ""}`, m.html, m.text); await db.from("mail_subs").update({ last_vote: new Date().toISOString().slice(0, 10) }).eq("email", v.email); votes++; }
    catch (e) { failed++; }
  }
  return new Response(JSON.stringify({ due: due?.length ?? 0, sent, votes, failed }));
});
