// Read gateway with signed media. Paths are taken ONLY from database rows
// (a ledger's own entries, or shared entries) — never from the request.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PATH_OK = /^[0-9a-f-]{8,40}\.[a-z0-9]{1,5}$/;
const TTL = 3600;

type Media = { path?: string; url?: string; type?: string };
function pathOf(m: Media): string | null {
  const p = m.path ?? (m.url ? m.url.replace(/^.*\/storage\/v1\/object\/(public\/)?media\//, "") : null);
  return p && PATH_OK.test(p) ? p : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: { mode?: string; tail?: string; token?: string; place?: string | null } = {};
  try { body = await req.json(); } catch (_) { /* empty */ }

  let data: any;
  if (body.mode === "ledger" && typeof body.tail === "string") {
    const r = await db.rpc("vp_get_ledger", { p_tail: body.tail });
    if (r.error) return new Response(JSON.stringify({ error: r.error.message }), { status: 400, headers: CORS });
    data = r.data;
    if (!data) return new Response("null", { headers: { ...CORS, "content-type": "application/json" } });
  } else if (body.mode === "view" && typeof (body as any).token === "string") {
    const r = await db.rpc("vp_get_view", { p_token: (body as any).token });
    if (r.error) return new Response(JSON.stringify({ error: r.error.message }), { status: 400, headers: CORS });
    data = r.data;
    if (!data) return new Response("null", { headers: { ...CORS, "content-type": "application/json" } });
  } else if (body.mode === "board") {
    const r = await db.rpc("vp_shared_board", { p_place: body.place ?? null });
    if (r.error) return new Response(JSON.stringify({ error: r.error.message }), { status: 400, headers: CORS });
    data = r.data;
  } else {
    return new Response(JSON.stringify({ error: "bad request" }), { status: 400, headers: CORS });
  }

  // Each row is signed under its own rule: a pup's OWN entries in full; anything that belongs to
  // someone else (board, candidate view, issues this pup backs) only as reviewed-ok images.
  const own: { media?: Media[] }[] = body.mode === "ledger" ? (data.entries ?? []) : [];
  const others: { media?: Media[] }[] = body.mode === "ledger" ? (data.backed ?? [])
    : Array.isArray(data) ? data : (data.entries ?? []);
  const isPub = (m: any) => m.mod === "ok" && !String(m.type).startsWith("video/");
  const paths = new Set<string>();
  for (const row of own) for (const m of (row.media ?? []) as any[]) { const p = pathOf(m); if (p) paths.add(p); }
  for (const row of others) for (const m of (row.media ?? []) as any[]) {
    if (!isPub(m)) continue;
    const p = pathOf(m); if (p) paths.add(p);
  }

  const signed = new Map<string, string>();
  if (paths.size) {
    const { data: s } = await db.storage.from("media").createSignedUrls([...paths], TTL);
    for (const x of s ?? []) if (x.signedUrl && x.path) signed.set(x.path, x.signedUrl);
  }
  // Other people's media is fail-closed: only images reviewed 'ok' get a URL.
  const sign = (row: { media?: Media[] }, isPublic: boolean) => {
    row.media = (row.media ?? [])
      .map((m: any) => {
        if (isPublic) {
          if (String(m.type).startsWith("video/")) return { type: m.type, hidden: "video" };
          if (m.mod === "blocked") return { type: m.type, hidden: "blocked" };
          if (m.mod === "hold") return { type: m.type, hidden: "held" };
          if (m.mod !== "ok") return { type: m.type, hidden: "pending" };
        }
        const p = pathOf(m); const u = p ? signed.get(p) : undefined;
        return u ? { type: m.type, url: u } : null;
      })
      .filter(Boolean) as Media[];
  };
  for (const row of own) sign(row, false);
  for (const row of others) sign(row, true);
  return new Response(JSON.stringify(data), { headers: { ...CORS, "content-type": "application/json" } });
});
