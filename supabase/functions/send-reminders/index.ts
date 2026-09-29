// Sends each subscribed device its reminder at the person's chosen local time (cron: every 15 min).
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";

webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
const LINES = [
  (n: string) => `Anything your city should fix today? ${n} is listening.`,
  (n: string) => `Saw something that needs fixing? Tell ${n}. Five words is plenty.`,
  (n: string) => `${n} is waiting by the door. Anything bug you today?`,
];

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: due, error } = await db.rpc("vp_due_reminders");
  if (error) return new Response("db: " + error.message, { status: 500 });
  let sent = 0, gone = 0, failed = 0;
  for (const s of due ?? []) {
    const line = LINES[Math.floor(Math.random() * LINES.length)](s.name);
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "🐾 " + s.name, body: line, url: "/p/" + s.tail }), { TTL: 3 * 3600 });
      await db.from("push_subs").update({ last_sent: new Date().toISOString(), fails: 0 }).eq("endpoint", s.endpoint);
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) { await db.from("push_subs").delete().eq("endpoint", s.endpoint); gone++; }
      else { failed++; }
    }
  }
  return new Response(JSON.stringify({ due: due?.length ?? 0, sent, gone, failed }));
});
