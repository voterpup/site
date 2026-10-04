// Pack chat: read and send messages for members only. Text is checked by Claude Haiku before anyone sees it
// (hate, threats, sexual content, scams); small photos and videos ride along (stored like other media, links signed per read).
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
const MODEL = "claude-haiku-4-5-20251001";
const PATH_OK = /^[0-9a-f-]{8,40}\.[a-z0-9]{1,5}$/;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

async function textOk(body: string): Promise<{ ok: boolean; why?: string }> {
  if (!body.trim()) return { ok: true };
  try {
    const r = await anthropic.messages.create({ model: MODEL, max_tokens: 60,
      system: "You moderate a friendly group chat between friends in a neighbourhood app. Block ONLY: hate or slurs, threats or incitement to violence, sexual content, harassment aimed at someone, scams or suspicious links, selling drugs or weapons. Swearing in a friendly way, jokes, politics talk and local complaints are fine. Reply with JSON only: {\"ok\":true} or {\"ok\":false,\"why\":\"<4 words>\"}.",
      messages: [{ role: "user", content: body.slice(0, 500) }] });
    const t = (r.content[0] as any)?.text ?? "";
    const m = t.match(/\{[\s\S]*\}/); const v = m ? JSON.parse(m[0]) : { ok: true };
    return { ok: v.ok !== false, why: v.why };
  } catch (_) { return { ok: true }; }   // the checker being down never blocks friends; reports still work
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const tail = String(b.tail || ""), pack = String(b.pack || "");
  if (!/^[0-9a-f-]{36}$/.test(pack) || !tail) return json({ error: "bad request" }, 400);
  const { data: mem } = await db.from("pack_members").select("status, role").eq("pack_id", pack).eq("tail", tail).maybeSingle();
  if (!mem || mem.status !== "active") return json({ error: "Not in this pack yet." }, 403);

  if (b.action === "read") {
    let q = db.from("pack_messages").select("id, tail, body, media, mod, created_at").eq("pack_id", pack).order("created_at", { ascending: false }).limit(60);
    if (b.before) q = q.lt("created_at", b.before);
    const { data: rows } = await q;
    const tails = [...new Set((rows ?? []).map((r: any) => r.tail))];
    const { data: names } = tails.length ? await db.from("ledgers").select("tail, name").in("tail", tails) : { data: [] as any[] };
    const nameOf = new Map((names ?? []).map((n: any) => [n.tail, n.name]));
    const paths = new Set<string>(); for (const r of rows ?? []) if (r.mod === "ok") for (const m of r.media ?? []) if (PATH_OK.test(m.path)) paths.add(m.path);
    const signed = new Map<string, string>();
    if (paths.size) { const { data: s } = await db.storage.from("media").createSignedUrls([...paths], 3600); for (const x of s ?? []) if (x.signedUrl && x.path) signed.set(x.path, x.signedUrl); }
    await db.from("pack_members").update({ last_read: new Date().toISOString() }).eq("pack_id", pack).eq("tail", tail);
    return json((rows ?? []).reverse().map((r: any) => ({ id: r.id, mine: r.tail === tail, who: nameOf.get(r.tail) ?? "a pup", ts: r.created_at,
      body: r.mod === "ok" ? r.body : null, hidden: r.mod !== "ok", media: r.mod === "ok" ? (r.media ?? []).map((m: any) => ({ type: m.type, url: signed.get(m.path) })).filter((m: any) => m.url) : [] })));
  }

  if (b.action === "send") {
    const body = String(b.body || "").slice(0, 500);
    const media = (Array.isArray(b.media) ? b.media : []).slice(0, 4).filter((m: any) => PATH_OK.test(String(m.path)) && /^(image|video)\/[a-z0-9.+-]+$/.test(String(m.type)))
      .map((m: any) => ({ path: m.path, type: m.type }));
    if (!body.trim() && !media.length) return json({ error: "Say something or add a photo." }, 400);
    const since = new Date(Date.now() - 6e5).toISOString();
    const { count } = await db.from("pack_messages").select("id", { count: "exact", head: true }).eq("tail", tail).gte("created_at", since);
    if ((count ?? 0) >= 40) return json({ error: "Slow down a little 🐾" }, 429);
    const chk = await textOk(body);
    if (!chk.ok) return json({ error: "That message wasn't sent" + (chk.why ? " (" + chk.why + ")" : "") + ". Keep it friendly 🐾" }, 422);
    const { data: msg, error } = await db.from("pack_messages").insert({ pack_id: pack, tail, body: body || null, media }).select("id, created_at").single();
    if (error) return json({ error: error.message }, 500);
    // a nudge to the others, at most once every 30 minutes each
    const { data: me } = await db.from("ledgers").select("name").eq("tail", tail).maybeSingle();
    const { data: pk } = await db.from("packs").select("name").eq("id", pack).maybeSingle();
    const cut = new Date(Date.now() - 18e5).toISOString();
    const { data: others } = await db.from("pack_members").select("tail, last_push").eq("pack_id", pack).eq("status", "active").neq("tail", tail);
    for (const o of others ?? []) {
      if (o.last_push && o.last_push > cut) continue;
      const { data: subs } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("tail", o.tail);
      if (!subs?.length) continue;
      await db.from("pack_members").update({ last_push: new Date().toISOString() }).eq("pack_id", pack).eq("tail", o.tail);
      for (const s of subs) webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "🐾 " + (pk?.name ?? "Your pack"), body: (me?.name ?? "A pup") + ": " + (body ? body.slice(0, 80) : "📷 sent a photo"), url: "/packs/" + pack }), { TTL: 6 * 3600 }).catch(() => {});
    }
    return json({ ok: true, id: msg.id, ts: msg.created_at });
  }
  return json({ error: "bad action" }, 400);
});
