// "Someone reacted 😂 to your post": pushes the owner (called by a DB trigger, at most once an hour per pup).
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";
webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: { entry_id?: string; emoji?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  if (!body.entry_id || !/^[0-9a-f-]{36}$/.test(body.entry_id)) return new Response("bad request", { status: 400 });
  const { data: e, error: ee } = await db.from("entries").select("tail, body").eq("id", body.entry_id).maybeSingle();
  if (!e) return new Response("no entry " + (ee?.message ?? ""), { status: 404 });
  const { data: led } = await db.from("ledgers").select("name").eq("tail", e.tail).maybeSingle();
  const { data: rs } = await db.from("emoji_reacts").select("emoji").eq("entry_id", body.entry_id);
  const n = rs?.length ?? 1, emo = String(body.emoji || "🐾").slice(0, 8);
  const about = "“" + String(e.body || "your photo").slice(0, 50) + "”";
  const text = n <= 1 ? "Someone reacted " + emo + " to " + about : emo + " " + n + " neighbours reacted to " + about;
  const { data: subs } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("tail", e.tail);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "🐾 " + (led?.name ?? "Your pup"), body: text, url: "/p/" + e.tail + "?reacts=1" }), { TTL: 6 * 3600, urgency: "normal" });
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
    }
  }
  return new Response(JSON.stringify({ sent }));
});
