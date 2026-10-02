// Delete a pup and everything it remembers: entries, photos, reactions, subscriptions, backups. The private link is the key.
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: { tail?: string; id?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const tail = String(body.tail || "");
  if (!/^[a-z0-9-]{1,30}~[0-9a-f]{20}$/.test(tail)) return new Response("bad request", { status: 400, headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const one = String(body.id || "").replace(/[^0-9a-f-]/g, "");
  if (one) {   // delete a single post (its photos too); the private link proves ownership
    const { data: e } = await db.from("entries").select("id, media").eq("id", one).eq("tail", tail).maybeSingle();
    if (!e) return new Response("not found", { status: 404, headers: CORS });
    const ps = ((e.media ?? []) as any[]).map((m) => m.path).filter(Boolean);
    if (ps.length) await db.storage.from("media").remove(ps);
    await db.storage.from("cards").remove([one + ".png"]).catch(() => {});
    const { error: de } = await db.from("entries").delete().eq("id", one).eq("tail", tail);
    if (de) return new Response(de.message, { status: 500, headers: CORS });
    return new Response(JSON.stringify({ deleted: 1, photos: ps.length }), { headers: { ...CORS, "content-type": "application/json" } });
  }
  const { data: rows } = await db.from("entries").select("media").eq("tail", tail);
  const paths: string[] = [];
  for (const r of rows ?? []) for (const m of (r.media ?? []) as any[]) if (m.path) paths.push(m.path);
  if (paths.length) await db.storage.from("media").remove(paths);
  const { error, count } = await db.from("ledgers").delete({ count: "exact" }).eq("tail", tail);   // cascades to everything else
  if (error) return new Response(error.message, { status: 500, headers: CORS });
  await db.from("events").delete().eq("tail", tail);
  return new Response(JSON.stringify({ deleted: count ?? 0, photos: paths.length }), { headers: { ...CORS, "content-type": "application/json" } });
});
