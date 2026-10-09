// That spot: bury a message at a place; it opens only for someone standing there (within the radius, plus GPS slack).
// Makers must be signed in (Google via Supabase auth; the user's JWT comes in the Authorization header). Finding a
// public or link drop needs no account. Text is checked by Claude Haiku before anyone can open it (fail-closed for makers).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, max);
const code = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; const b = crypto.getRandomValues(new Uint8Array(10)); return Array.from(b, (x) => a[x % a.length]).join(""); };
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function metres(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, r = Math.PI / 180, dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(aLat: number, aLng: number, bLat: number, bLng: number) {   // degrees from north, finder -> spot
  const r = Math.PI / 180, y = Math.sin((bLng - aLng) * r) * Math.cos(bLat * r), x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLng - aLng) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const SLACK = 60;   // metres of GPS error we forgive, capped
async function logFail(svc: string, msg: unknown) {
  try { const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); await db.from("svc_errors").insert({ svc, msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* nothing */ }
}
async function textOk(body: string): Promise<{ ok: boolean; why?: string }> {
  if (!body.trim()) return { ok: true };
  try {
    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
    const r = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 60,
      system: "You moderate short notes people leave at real-world places for friends or strangers to find. Block ONLY: hate or slurs, threats or incitement, sexual content, harassment aimed at a person, doxxing (a private person's address, phone, workplace), scams or suspicious links, selling drugs or weapons, instructions that could get a finder hurt. Jokes, affection, riddles, memories, swearing in a friendly way, and opinions are fine. Reply with JSON only: {\"ok\":true} or {\"ok\":false,\"why\":\"<4 words>\"}.",
      messages: [{ role: "user", content: body.slice(0, 700) }] });
    const t = (r.content[0] as any)?.text ?? ""; const m = t.match(/\{[\s\S]*\}/); const v = m ? JSON.parse(m[0]) : { ok: false };
    return { ok: v.ok === true, why: v.why };
  } catch (e) { await logFail("thatspot moderation", e); return { ok: false, why: "checker unavailable" }; }   // fail closed: nothing unchecked gets buried
}
function pubSpot(s: any, extra: Record<string, unknown> = {}) {
  return { code: s.code, clue: s.clue, visibility: s.visibility, opens_at: s.opens_at, created_at: s.created_at, radius_m: s.radius_m, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null, ...extra };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const a = String(b.action || "");

  // who is calling: a signed-in profile, or nobody
  let user: any = null;
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token && token !== anon) {
    const { data } = await createClient(url, anon, { global: { headers: { Authorization: "Bearer " + token } } }).auth.getUser();
    user = data?.user ?? null;
  }
  async function profile() {   // the quick profile: created from the Google account on first use
    if (!user) return null;
    const { data: p } = await db.from("spot_profiles").select("*").eq("uid", user.id).maybeSingle();
    if (p) return p;
    const name = clean(user.user_metadata?.full_name || user.user_metadata?.name || (user.email || "").split("@")[0], 40) || "Someone";
    const photo = clean(user.user_metadata?.avatar_url || user.user_metadata?.picture, 400) || null;
    const { data: np } = await db.from("spot_profiles").insert({ uid: user.id, name, photo }).select("*").single();
    return np;
  }

  // QA only: mint a session for a throwaway test account when the QA_KEY secret matches (never exposed in the page)
  if (a === "qa") {
    const k = Deno.env.get("QA_KEY"); if (!k || b.key !== k) return json({ error: "no" }, 403);
    const email = "qa-" + clean(b.who, 8).replace(/[^a-z0-9]/gi, "") + "@voterpup.test", pw = k + "-pw";
    const list = await db.auth.admin.listUsers({ perPage: 200 });
    if (!(list.data?.users ?? []).some((u: any) => u.email === email)) await db.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { full_name: "QA " + clean(b.who, 8) } });
    const { data, error } = await createClient(url, anon).auth.signInWithPassword({ email, password: pw });
    if (error) return json({ error: error.message }, 500);
    return json({ token: data.session?.access_token });
  }

  if (a === "me") { const p = await profile(); return json({ profile: p ? { name: p.name, photo: p.photo } : null }); }
  if (a === "rename") { const p = await profile(); if (!p) return json({ error: "sign in" }, 401); const name = clean(b.name, 40); if (!name) return json({ error: "missing" }, 400); await db.from("spot_profiles").update({ name }).eq("uid", user.id); return json({ ok: true }); }

  if (a === "bury") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    const lat = num(b.lat), lng = num(b.lng), body = clean(b.body, 600), clue = clean(b.clue, 140) || null;
    const vis = ["link", "public"].includes(b.visibility) ? b.visibility : "link";
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "no location" }, 400);
    if (!body) return json({ error: "missing" }, 400);
    let opens: string | null = null;
    if (b.opens_at) { const t = new Date(b.opens_at); if (isNaN(t.getTime())) return json({ error: "bad time" }, 400); opens = t.toISOString(); }
    const chk = await textOk(body + (clue ? "\n" + clue : "")); if (!chk.ok) return json({ error: "That didn't pass our safety check" + (chk.why ? " (" + chk.why + ")" : "") }, 422);
    const c = code();
    const { error } = await db.from("spots").insert({ code: c, maker: user.id, lat, lng, body, clue, visibility: vis, opens_at: opens, src: clean(b.src, 24) || null });
    if (error) { await logFail("thatspot bury", error); return json({ error: "db: " + error.message }, 500); }
    return json({ code: c });
  }

  if (a === "mine") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    const { data } = await db.from("spots").select("*, spot_finds(id, finder_name, note, created_at)").eq("maker", user.id).order("created_at", { ascending: false }).limit(100);
    return json({ spots: (data ?? []).map((s: any) => ({ ...pubSpot(s), body: s.body, lat: s.lat, lng: s.lng, finds: (s.spot_finds ?? []).sort((x: any, y: any) => x.created_at < y.created_at ? 1 : -1) })) });
  }
  if (a === "found") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    const { data } = await db.from("spot_finds").select("created_at, note, spots(code, clue, visibility, created_at, radius_m, spot_profiles(name, photo))").eq("finder_uid", user.id).order("created_at", { ascending: false }).limit(100);
    return json({ finds: (data ?? []).map((f: any) => ({ found_at: f.created_at, note: f.note, ...pubSpot(f.spots) })) });
  }

  if (a === "near") {
    const lat = num(b.lat), lng = num(b.lng); if (lat === null || lng === null) return json({ error: "no location" }, 400);
    const d = 0.02;   // ~2 km box, then exact distance
    const { data } = await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").gte("lat", lat - d).lte("lat", lat + d).gte("lng", lng - d * 1.5).lte("lng", lng + d * 1.5).limit(200);
    const now = Date.now();
    const list = (data ?? []).filter((s: any) => !s.opens_at || new Date(s.opens_at).getTime() <= now)
      .map((s: any) => pubSpot(s, { distance_m: Math.round(metres(lat, lng, s.lat, s.lng)), finds: (s.spot_finds ?? []).length }))
      .filter((s: any) => s.distance_m <= 2500).sort((x: any, y: any) => x.distance_m - y.distance_m).slice(0, 40);
    return json({ spots: list });
  }

  const c = clean(b.code, 12).replace(/[^a-z0-9]/g, "");
  const { data: s } = c ? await db.from("spots").select("*, spot_profiles(name, photo)").eq("code", c).maybeSingle() : { data: null };
  if (!s) return json({ error: "not found" }, 404);
  const isMaker = !!user && user.id === s.maker;

  if (a === "toggle") {
    if (!isMaker) return json({ error: "not yours" }, 403);
    const vis = ["link", "public", "hidden"].includes(b.visibility) ? b.visibility : null; if (!vis) return json({ error: "bad visibility" }, 400);
    await db.from("spots").update({ visibility: vis }).eq("id", s.id); return json({ ok: true, visibility: vis });
  }
  if (s.visibility === "hidden" && !isMaker) return json({ error: "not found" }, 404);

  if (a === "peek") {
    const { count } = await db.from("spot_finds").select("id", { count: "exact", head: true }).eq("spot_id", s.id);
    return json(pubSpot(s, { finds: count ?? 0, is_maker: isMaker, bound: !!s.bound_uid, mine_bound: !!user && s.bound_uid === user.id }));
  }

  // open and reply both need the finder to be standing there
  const lat = num(b.lat), lng = num(b.lng), acc = Math.min(Math.max(num(b.acc) ?? 30, 0), SLACK);
  if (lat === null || lng === null) return json({ error: "no location" }, 400);
  const dist = metres(lat, lng, s.lat, s.lng), there = isMaker || dist <= s.radius_m + acc;
  if (a === "open") {
    if (s.opens_at && new Date(s.opens_at).getTime() > Date.now()) return json({ sealed: true, opens_at: s.opens_at, distance_m: Math.round(dist) });
    if (s.visibility === "link" && user && !isMaker) {
      if (!s.bound_uid) await db.from("spots").update({ bound_uid: user.id }).eq("id", s.id);
      else if (s.bound_uid !== user.id) return json({ error: "This one was buried for someone else" }, 403);
    }
    if (!there) return json({ there: false, distance_m: Math.round(dist), bearing_deg: Math.round(bearing(lat, lng, s.lat, s.lng)) });
    if (!isMaker) {
      const p = user ? await profile() : null;
      const { data: already } = user ? await db.from("spot_finds").select("id").eq("spot_id", s.id).eq("finder_uid", user.id).limit(1) : { data: [] };
      if (!(already ?? []).length) await db.from("spot_finds").insert({ spot_id: s.id, finder_uid: user?.id ?? null, finder_name: p?.name ?? null, lat, lng });
    }
    const { data: finds } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", s.id).order("created_at", { ascending: false }).limit(50);
    return json({ there: true, distance_m: Math.round(dist), body: s.body, buried_at: s.created_at, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null, logbook: finds ?? [], is_maker: isMaker });
  }
  if (a === "reply") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    if (!there) return json({ error: "You need to be there" }, 400);
    const note = clean(b.note, 300); if (!note) return json({ error: "missing" }, 400);
    const chk = await textOk(note); if (!chk.ok) return json({ error: "That didn't pass our safety check" }, 422);
    const { data: mineF } = await db.from("spot_finds").select("id").eq("spot_id", s.id).eq("finder_uid", user.id).order("created_at", { ascending: false }).limit(1);
    if ((mineF ?? []).length) await db.from("spot_finds").update({ note, finder_name: p.name }).eq("id", mineF![0].id);
    else await db.from("spot_finds").insert({ spot_id: s.id, finder_uid: user.id, finder_name: p.name, note, lat, lng });
    const { data: finds } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", s.id).order("created_at", { ascending: false }).limit(50);
    return json({ ok: true, logbook: finds ?? [] });
  }
  return json({ error: "unknown action" }, 400);
});
