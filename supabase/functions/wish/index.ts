// Wish Wall: add one anonymous "I wish…" line. Checked by Claude Haiku before it shows (no people, no hate, no ads);
// the position is rounded to ~100 m so a wish never pins a doorstep. Prototype: only pups on the proto list may post.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
async function logFail(db: any, msg: unknown) { try { await db.from("svc_errors").insert({ svc: "wish", msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* never block */ } }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const tail = String(b.tail || ""), city = String(b.city || "").toLowerCase().slice(0, 60);
  let body = String(b.body || "").replace(/\s+/g, " ").trim().slice(0, 130);
  if (!body || body.length < 3 || !city) return json({ error: "Write a few words." }, 400);
  if (!/^i wish\b/i.test(body)) body = "I wish " + body.charAt(0).toLowerCase() + body.slice(1);
  const { data: proto } = await db.rpc("vp_is_proto", { p_tail: tail });
  if (!proto) return json({ error: "Wishes are coming soon 🐾" }, 403);
  const { count } = await db.from("wishes").select("id", { count: "exact", head: true }).eq("tail", tail).gte("created_at", new Date(Date.now() - 864e5).toISOString());
  if ((count ?? 0) >= 10) return json({ error: "That's plenty of wishes for today. Come back tomorrow 🐾" }, 429);
  let ok = true, why = "";
  try {
    const r = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 60,
      system: "You check one anonymous wish posted on a neighbourhood wall. Allow wishes about places, services, the city, daily life, even sarcastic or grumpy ones (\"I wish the bus came on time\", \"I wish my neighbour's dog stopped barking at 5 am\"). Block ONLY: anything naming or describing a specific identifiable person, hate or demeaning words about any group, threats, sexual content, ads or links, phone numbers or addresses, and anything about voting for or against a candidate or party. Reply JSON only: {\"ok\":true} or {\"ok\":false,\"why\":\"<4 words>\"}.",
      messages: [{ role: "user", content: body }] });
    const t = (r.content[0] as any)?.text ?? ""; const m = t.match(/\{[\s\S]*\}/); const v = m ? JSON.parse(m[0]) : { ok: true };
    ok = v.ok !== false; why = v.why ?? "";
  } catch (e) { await logFail(db, e); }   // the checker being down never blocks a wish; reports still work
  if (!ok) return json({ error: "That wish wasn't posted" + (why ? " (" + why + ")" : "") + ". Keep it about places, not people 🐾" }, 422);
  const la = Number(b.lat), lo = Number(b.lng), has = isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
  const { data, error } = await db.from("wishes").insert({ tail, body, city, lat: has ? Math.round(la * 1e3) / 1e3 : null, lng: has ? Math.round(lo * 1e3) / 1e3 : null }).select("id, created_at").single();
  if (error) return json({ error: error.message }, 500);
  await db.from("wish_paws").insert({ wish_id: data.id, tail });   // your own wish starts with your paw
  return json({ ok: true, id: data.id, body });
});
