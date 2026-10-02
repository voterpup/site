// One-off maintenance: GET lists big photos with signed URLs; POST {path, b64} replaces one with a smaller JPEG. Report key required.
import { createClient } from "npm:@supabase/supabase-js@2";
Deno.serve(async (req) => {
  const url = new URL(req.url), db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (req.method === "GET") {
    if (url.searchParams.get("key") !== Deno.env.get("REPORT_KEY")) return new Response("no", { status: 403 });
    const { data } = await db.storage.from("media").list("", { limit: 1000 });
    const big = (data ?? []).filter((o: any) => (o.metadata?.size ?? 0) > 400000);
    const out = [];
    for (const o of big) { const { data: s } = await db.storage.from("media").createSignedUrl(o.name, 600); out.push({ path: o.name, size: o.metadata.size, url: s?.signedUrl }); }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }
  const b = await req.json();
  if (b.key !== Deno.env.get("REPORT_KEY")) return new Response("no", { status: 403 });
  const bytes = Uint8Array.from(atob(b.b64), (c) => c.charCodeAt(0));
  const { error } = await db.storage.from("media").upload(b.path, bytes, { contentType: "image/jpeg", upsert: true });
  return new Response(JSON.stringify({ ok: !error, error: error?.message, size: bytes.length }));
});
