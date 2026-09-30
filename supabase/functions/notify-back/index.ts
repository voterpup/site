// "Someone feels the same": pushes the owner of a backed issue (called by a DB trigger, rate-limited there).
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";
webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: { entry_id?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  if (!body.entry_id || !/^[0-9a-f-]{36}$/.test(body.entry_id)) return new Response("bad request", { status: 400 });
  const { data: e } = await db.from("entries").select("tail, body, ledgers(name)").eq("id", body.entry_id).maybeSingle();
  if (!e) return new Response("no entry", { status: 404 });
  const { count } = await db.from("backs").select("entry_id", { count: "exact", head: true }).eq("entry_id", body.entry_id);
  const { data: subs } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("tail", e.tail);
  const name = (e as any).ledgers?.name ?? "Your pup";
  const n = count ?? 1;
  const text = (n === 1 ? "Someone feels the same" : n + " people feel the same") + " about “" + String(e.body || "your photo").slice(0, 60) + "”";
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "🐾 " + name, body: text, url: "/p/" + e.tail }), { TTL: 6 * 3600, urgency: "normal" });
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
    }
  }
  return new Response(JSON.stringify({ sent }));
});
