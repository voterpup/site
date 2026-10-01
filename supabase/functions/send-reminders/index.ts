// Sends each subscribed device its reminder at the person's chosen local time (cron: every 15 min).
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";

webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
const LINES = [
  (n: string) => `Anything your city should fix today? ${n} is listening.`,
  (n: string) => `Saw something that needs fixing? Tell ${n}. Five words is plenty.`,
  (n: string) => `${n} is waiting by the door. Anything bug you today?`,
];

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: { test?: string } = {};
  try { body = await req.json(); } catch (_) { /* cron sends {} */ }
  // "Send a test": only to a subscription the caller's own browser holds (the endpoint is unguessable)
  let due: any[] | null, error: any;
  if (body.test) ({ data: due, error } = await db.from("push_subs").select("endpoint, p256dh, auth, tail, ledgers(name)").eq("endpoint", body.test));
  else ({ data: due, error } = await db.rpc("vp_due_reminders"));
  if (error) return new Response("db: " + error.message, { status: 500, headers: CORS });
  due = (due ?? []).map((s: any) => ({ ...s, name: s.name ?? s.ledgers?.name ?? "Your pup" }));

  // vote morning: "today you vote" -> the pup's list (Flashback)
  let votes = 0;
  if (!body.test) {
    const { data: vd } = await db.rpc("vp_due_vote_pushes");
    for (const v of vd ?? []) {
      try {
        await webpush.sendNotification({ endpoint: v.endpoint, keys: { p256dh: v.p256dh, auth: v.auth } },
          JSON.stringify({ title: "\ud83d\uddf3\ufe0f Today you vote" + (v.city ? " in " + v.city : ""),
                           body: v.name + " has your Flashback ready. " + v.election + ".", url: "/p/" + v.tail + "?flash=1" }),
          { TTL: 12 * 3600, urgency: "high" });
        await db.from("push_subs").update({ last_vote_push: new Date().toISOString().slice(0, 10) }).eq("endpoint", v.endpoint);
        votes++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", v.endpoint);
      }
    }
  }
  let sent = 0, gone = 0, failed = 0;
  for (const s of due ?? []) {
    let line = LINES[Math.floor(Math.random() * LINES.length)](s.name);
    if (!body.test) {
      const { data: f } = await db.rpc("vp_reminder_facts", { p_tail: s.tail });
      const st = f?.stats ?? {};
      if (!s.last_sent && f?.city && (st.issues_week ?? 0) >= 3)
        line = `${s.name}'s first report: ${st.issues_week} issues raised in ${f.city} this week` +
               (st.top_topic ? `, most on #${st.top_topic}` : "") + ". Anything to add?";
      else if (f?.top?.rank && f.top.rank <= 5)
        line = `\u201c${String(f.top.body || "your photo").slice(0, 40)}\u201d is #${f.top.rank}${f.top.city ? " in " + f.top.city : ""} this week. Anything new today?`;
      else if ((f?.backs ?? 0) > 0)
        line = `${f.backs} ${f.backs === 1 ? "person feels" : "people feel"} the same as you so far. Anything new today?`;
      else if ((f?.entries ?? 0) === 0)
        line = `${s.name} hasn't heard anything yet. What should be fixed?`;
      else if (f?.city && ((f.today?.issues ?? 0) >= 2 || (f.city_reports?.n ?? 0) >= 20))   // the day's pulse, different every day
        line = `Today in ${f.city}: ` + ((f.today?.issues ?? 0) ? `${f.today.issues} issues from ${f.today.pups} people` : "") +
               ((f.today?.issues ?? 0) && (f.city_reports?.n ?? 0) ? " + " : "") + ((f.city_reports?.n ?? 0) ? `${f.city_reports.n} 3-1-1 reports` : "") +
               ((f.today?.top_topic || f.city_reports?.top_topic) ? `, most on #${f.today?.top_topic || f.city_reports.top_topic}` : "") + `. Anything to add?`;
      else if (f?.city && (st.issues_week ?? 0) >= 3)
        line = `This week in ${f.city}: ${st.issues_week} issues from ${st.pups_week} people` + (st.top_topic ? `, most on #${st.top_topic}` : "") + `. Anything to add?`;
    }
    try {
      const r = await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "🐾 " + s.name, body: body.test ? "Test reminder: this is how " + s.name + " will ask." : line, url: "/p/" + s.tail + "?add=1" }),
        { TTL: 3600, urgency: "high" });
      console.log("push", new URL(s.endpoint).host, r.statusCode);
      if (!body.test) await db.from("push_subs").update({ last_sent: new Date().toISOString(), fails: 0 }).eq("endpoint", s.endpoint);
      sent++;
    } catch (e: any) {
      console.log("push error", e?.statusCode, String(e?.body ?? e?.message ?? e).slice(0, 200));
      if (e?.statusCode === 404 || e?.statusCode === 410) { await db.from("push_subs").delete().eq("endpoint", s.endpoint); gone++; }
      else { failed++; }
    }
  }
  return new Response(JSON.stringify({ due: due?.length ?? 0, sent, gone, failed, votes }), { headers: CORS });
});
