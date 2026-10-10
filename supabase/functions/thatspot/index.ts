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
const PHOTO_RULES = `You check one photo that a person is leaving at a real-world place for a friend or for strangers to find.
Block it if it contains ANY of: nudity or sexual content of anyone; any child (anyone who may be under 18) who is unclothed or partly clothed (including swimwear or underwear) or shown in a sexualised or suggestive way; graphic violence, gore or self-harm; hate symbols or hateful text; a readable private address, phone number or ID document.
Ordinary everyday photos are fine: places, benches, views, pets, food, people fully clothed, handwritten notes.
Call report_image exactly once.`;
async function photoOk(db: any, path: string): Promise<boolean> {   // fail closed
  try {
    const { data: su } = await db.storage.from("media").createSignedUrl(path, 120); if (!su?.signedUrl) return false;
    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
    const r = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 200, system: PHOTO_RULES,
      tools: [{ name: "report_image", description: "Report the verdict.", input_schema: { type: "object", properties: { verdict: { type: "string", enum: ["ok", "block"] }, reason: { type: "string" } }, required: ["verdict", "reason"] } }],
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: su.signedUrl } }, { type: "text", text: "Check this photo and call report_image." }] }] } as any);
    if (r.stop_reason === "refusal") return false;
    const call = r.content.find((x: any) => x.type === "tool_use") as any; return call?.input?.verdict === "ok";
  } catch (e) { await logFail("thatspot photo check", e); return false; }
}
async function signedPhoto(db: any, path: string | null) { if (!path) return null; const { data } = await db.storage.from("media").createSignedUrl(path, 3600); return data?.signedUrl ?? null; }
const SITE = "https://voterpup.com";
async function mail(to: string, subject: string, body: string, cta: string, url: string, unsub: string) {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key) throw new Error("no RESEND_API_KEY");
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#1d2433"><p style="font-size:22px;margin:0 0 6px">📍 My spot</p><p style="font-size:16px;line-height:1.5;white-space:pre-line">${esc(body)}</p><p><a href="${url}" style="display:inline-block;background:#e8b84b;color:#2a2418;font-weight:800;padding:12px 18px;border-radius:999px;text-decoration:none">${esc(cta)}</a></p><p style="font-size:12px;color:#6b7387;margin-top:28px">You asked for this at voterpup.com/myspot. <a href="${unsub}" style="color:#6b7387">Unsubscribe</a> · <a href="${SITE}/privacy.html" style="color:#6b7387">Privacy</a></p></div>`;
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ from: "VoterPup <pup@voterpup.com>", to: [to], subject, html, text: `${body}\n\n${cta}: ${url}\n\nUnsubscribe: ${unsub}`, headers: { "List-Unsubscribe": `<${unsub}>` } }) });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 160));
}
const tokenOf = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
function isOwner(s: any, user: any) { return !!user && s.owner_status === "approved" && ((s.owner_uid && s.owner_uid === user.id) || (s.owner_email && user.email && s.owner_email.toLowerCase() === String(user.email).toLowerCase())); }
function pubSpot(s: any, extra: Record<string, unknown> = {}) {
  return { code: s.code, kind: s.kind || 'memory', place_name: s.place_name || null, clue: s.clue, visibility: s.visibility, opens_at: s.opens_at, created_at: s.created_at, radius_m: s.radius_m, has_photo: !!s.photo, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null, ...extra };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (req.method === "GET") {
    const tok = (new URL(req.url).searchParams.get("unsub") || "").replace(/[^a-f0-9]/g, "");
    if (tok) await db.from("spot_subs").update({ unsub_at: new Date().toISOString() }).eq("token", tok);
    return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content=width=device-width><body style=font-family:system-ui;padding:40px;text-align:center><h2>Unsubscribed</h2><p>No more emails about that spot.</p>", { headers: { "content-type": "text/html" } });
  }
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const a = String(b.action || "");
  const FN = url + "/functions/v1/thatspot";

  if (a === "cron") {   // the daily reasons to come back
    const now = new Date(), nowIso = now.toISOString(); let sent = 0, failed = 0;
    const { data: subs } = await db.from("spot_subs").select("*").is("unsub_at", null).limit(2000);
    for (const sub of subs ?? []) {
      const since = sub.last_sent || sub.created_at; let text: string | null = null, cta = "", link = "";
      try {
        if (sub.kind === "my_memory") {
          const { data: sp } = await db.from("spots").select("id, code, body, place_code, place_name").eq("code", sub.spot_code).maybeSingle(); if (!sp) continue;
          const { data: f } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", sp.id).gt("created_at", since).neq("finder_uid", sub.uid ?? "00000000-0000-0000-0000-000000000000");
          const opens = (f ?? []).length, notes = (f ?? []).filter((x: any) => x.note);
          if (!opens) continue;
          text = `${opens === 1 ? "Someone" : opens + " people"} opened your memory "${String(sp.body || "").slice(0, 60)}"` + (notes.length ? `, and ${notes.length === 1 ? "one left a note" : notes.length + " left notes"}: "${String(notes[0].note).slice(0, 80)}"` : "") + ".";
          cta = "See it"; link = `${SITE}/myspot/?d=${sp.code}`;
        } else {
          const { data: pl } = await db.from("spots").select("code, place_name, lat, lng").eq("code", sub.spot_code).maybeSingle(); if (!pl) continue;
          const { data: nw } = await db.from("spots").select("code").eq("place_code", pl.code).eq("visibility", "public").gt("created_at", since);
          if (!(nw ?? []).length) continue;
          text = `${(nw ?? []).length === 1 ? "A new memory was" : (nw ?? []).length + " new memories were"} left at ${pl.place_name} since you were there. They open when you're standing inside.`;
          cta = "See what's new"; link = `${SITE}/myspot/?at=${pl.code}`;
        }
        await mail(sub.email, "📍 " + (sub.kind === "my_memory" ? "Someone opened your memory" : "New at " + text.split(" at ")[1]?.split(" since")[0]), text, cta, link, `${FN}?unsub=${sub.token}`); sent++;
        await db.from("spot_subs").update({ last_sent: nowIso }).eq("id", sub.id);
      } catch (e) { failed++; await logFail("myspot mail", e); }
    }
    let owners = 0;
    if (now.getUTCDay() === 1) {   // Monday: the shops' weekly numbers
      const { data: places } = await db.from("spots").select("*").eq("kind", "place").not("owner_email", "is", null);
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      for (const pl of places ?? []) {
        try {
          const { data: opens } = await db.from("spot_finds").select("finder_uid, created_at").eq("spot_id", pl.id);
          const { data: posts } = await db.from("spots").select("code, created_at").eq("place_code", pl.code).eq("visibility", "public");
          const wk = (opens ?? []).filter((o: any) => o.created_at >= since).length, pw = (posts ?? []).filter((p: any) => p.created_at >= since).length;
          const uniq = new Set((opens ?? []).map((o: any) => o.finder_uid || "anon")).size, rep = Object.values((opens ?? []).reduce((m: any, o: any) => { if (o.finder_uid) m[o.finder_uid] = (m[o.finder_uid] || 0) + 1; return m; }, {})).filter((n: any) => n > 1).length;
          const text = `${pl.place_name}, this week: ${wk} ${wk === 1 ? "person" : "people"} opened the spot and ${pw} ${pw === 1 ? "memory was" : "memories were"} left.\nSince the start: ${(opens ?? []).length} opens, ${(posts ?? []).length} memories, ${uniq} different visitors, ${rep} came back more than once.`;
          await mail(pl.owner_email, "📍 " + pl.place_name + ": your week on My spot", text, "See the spot", `${SITE}/myspot/?at=${pl.code}`, `${FN}?unsub=none`); owners++;
        } catch (e) { await logFail("myspot owner mail", e); }
      }
    }
    return json({ sent, failed, owners });
  }

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

  if (a === "otp") {   // sign-in code sent by us through Resend, so Supabase's built-in mailer and its hourly limit are never in the way
    const em = clean(b.email, 120).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: "bad email" }, 400);
    const { data: g, error } = await db.auth.admin.generateLink({ type: "magiclink", email: em, options: { redirectTo: SITE + "/myspot/" } } as any);
    if (error || !g?.properties?.email_otp) { await logFail("thatspot otp", error || "no otp"); return json({ error: "could not make a code" + (error ? ": " + error.message : "") }, 500); }
    try {
      await mail(em, "Your Memspots code: " + g.properties.email_otp, "Your sign-in code is " + g.properties.email_otp + ". It works for a few minutes. If you didn't ask for it, ignore this email.", "Open Memspots", SITE + "/myspot/", SITE + "/privacy.html");
    } catch (e) { await logFail("thatspot otp mail", e); return json({ error: "could not send the email" }, 500); }
    return json({ ok: true });
  }
  if (a === "me") { const p = await profile(); return json({ profile: p ? { name: p.name, photo: p.photo } : null }); }
  if (a === "rename") { const p = await profile(); if (!p) return json({ error: "sign in" }, 401); const name = clean(b.name, 40); if (!name) return json({ error: "missing" }, 400); await db.from("spot_profiles").update({ name }).eq("uid", user.id); return json({ ok: true }); }

  if (a === "bury") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    const lat = num(b.lat), lng = num(b.lng), clue = clean(b.clue, 140) || null;
    const isPlace = b.kind === "place", placeName = clean(b.place_name, 60) || null;
    if (isPlace && !clean(b.body, 600)) b.body = "Welcome to " + placeName + ". Leave something here for the next person.";
    if (isPlace && !placeName) return json({ error: "shop name missing" }, 400);
    const vis = isPlace ? "public" : ["personal", "link", "public"].includes(b.visibility) ? b.visibility : "link";
    const body = clean(b.body, 600);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "no location" }, 400);
    if (!body && !isPlace && !(typeof b.photo_b64 === "string" && b.photo_b64.length)) return json({ error: "missing" }, 400);
    let placeCode: string | null = null;
    if (!isPlace && typeof b.place_code === "string" && b.place_code) {
      const pc = clean(b.place_code, 12).replace(/[^a-z0-9]/g, "");
      const { data: pl } = await db.from("spots").select("code, lat, lng, radius_m").eq("code", pc).eq("kind", "place").maybeSingle();
      if (!pl) return json({ error: "no such shop" }, 404);
      const dpl = metres(lat, lng, pl.lat, pl.lng), accpl = Math.min(Math.max(num(b.acc) ?? 30, 0), SLACK);
      if (dpl > pl.radius_m + accpl) return json({ error: "You need to be at the shop to post here (you're " + Math.round(dpl) + " m away)" }, 400);
      placeCode = pl.code;
    }
    let opens: string | null = null;
    if (b.opens_at) { const t = new Date(b.opens_at); if (isNaN(t.getTime())) return json({ error: "bad time" }, 400); opens = t.toISOString(); }
    const chk = await textOk(body + (clue ? "\n" + clue : "") + (placeName ? "\n" + placeName : "")); if (!chk.ok) return json({ error: "That didn't pass our safety check" + (chk.why ? " (" + chk.why + ")" : "") }, 422);
    const c = code();
    let photoPath: string | null = null;
    if (typeof b.photo_b64 === "string" && b.photo_b64.length) {
      const m = b.photo_b64.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/); if (!m || m[1].length > 2_200_000) return json({ error: "photo too big" }, 413);
      const bytes = Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0)); photoPath = "spots/" + c + ".jpg";
      const up = await db.storage.from("media").upload(photoPath, bytes, { contentType: "image/jpeg", upsert: false });
      if (up.error) { await logFail("thatspot upload", up.error); return json({ error: "photo upload failed" }, 500); }
      if (!(await photoOk(db, photoPath))) { await db.storage.from("media").remove([photoPath]); return json({ error: "That photo didn't pass our safety check" }, 422); }
    }
    const { error } = await db.from("spots").insert({ code: c, maker: user.id, lat, lng, body, clue, photo: photoPath, visibility: vis, opens_at: opens, kind: isPlace ? "place" : "memory", place_name: placeName, place_code: placeCode, radius_m: isPlace ? 60 : 40, src: clean(b.src, 24) || null });
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

  if (a === "notify") {   // "tell me when someone reads it" / "tell me when new memories appear here"
    const kind = b.kind === "place_new" ? "place_new" : "my_memory", sc = clean(b.spot_code, 12).replace(/[^a-z0-9]/g, "");
    const em = (clean(b.email, 120) || user?.email || "").toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: "bad email" }, 400);
    const { data: sp } = await db.from("spots").select("code, kind, maker").eq("code", sc).maybeSingle(); if (!sp) return json({ error: "not found" }, 404);
    if (kind === "my_memory" && (!user || sp.maker !== user.id)) return json({ error: "not yours" }, 403);
    if (kind === "place_new" && sp.kind !== "place") return json({ error: "not a shop" }, 400);
    const { error } = await db.from("spot_subs").upsert({ email: em, uid: user?.id ?? null, kind, spot_code: sc, token: tokenOf(), unsub_at: null }, { onConflict: "email,kind,spot_code" });
    if (error) return json({ error: "db: " + error.message }, 500);
    return json({ ok: true, email: em });
  }
  if (a === "claim") {   // an owner asks for their shop; the founder verifies and approves
    const pc = clean(b.code, 12).replace(/[^a-z0-9]/g, ""); const { data: pl } = await db.from("spots").select("*").eq("code", pc).eq("kind", "place").maybeSingle(); if (!pl) return json({ error: "not found" }, 404);
    const em = (clean(b.email, 120) || user?.email || "").toLowerCase(), name = clean(b.name, 60), note = clean(b.note, 300);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || !name) return json({ error: "name and email needed" }, 400);
    if (pl.owner_status === "approved") return json({ error: "This shop already has a verified owner. Email hi@voterpup.com if that's wrong." }, 409);
    await db.from("spots").update({ owner_email: em, owner_uid: user?.id ?? null, owner_status: "pending", claim_note: name + " · " + note }).eq("id", pl.id);
    try { await mail("hi@voterpup.com", "Shop claim: " + pl.place_name, `${name} <${em}> claims ${pl.place_name} (code ${pl.code}).\n\n${note}\n\nApprove with place_admin approve:true once verified.`, "Open the shop", SITE + "/myspot/?at=" + pl.code, SITE + "/privacy.html"); } catch (e) { await logFail("claim mail", e); }
    return json({ ok: true, status: "pending" });
  }
  if (a === "owner_stats" || a === "owner_hide" || a === "owner_note") {
    const pc = clean(b.code, 12).replace(/[^a-z0-9]/g, ""); const { data: pl } = await db.from("spots").select("*").eq("code", pc).eq("kind", "place").maybeSingle(); if (!pl) return json({ error: "not found" }, 404);
    if (!isOwner(pl, user)) return json({ error: "not the owner" }, 403);
    if (a === "owner_note") { const body = clean(b.body, 600); if (!body) return json({ error: "missing" }, 400); const chk = await textOk(body); if (!chk.ok) return json({ error: "That didn't pass our safety check" }, 422); await db.from("spots").update({ body }).eq("id", pl.id); return json({ ok: true }); }
    if (a === "owner_hide") { const mc = clean(b.memory, 12).replace(/[^a-z0-9]/g, ""); const { data: m } = await db.from("spots").select("id, place_code").eq("code", mc).maybeSingle(); if (!m || m.place_code !== pl.code) return json({ error: "not on your wall" }, 400); await db.from("spots").update({ hidden_by_owner: b.hidden !== false }).eq("id", m.id); return json({ ok: true }); }
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: opens } = await db.from("spot_finds").select("finder_uid, created_at").eq("spot_id", pl.id);
    const { data: posts } = await db.from("spots").select("code, created_at, body, photo, hidden_by_owner, spot_profiles(name)").eq("place_code", pl.code).eq("visibility", "public").order("created_at", { ascending: false }).limit(100);
    const uniq = new Set((opens ?? []).map((o: any) => o.finder_uid || "anon")).size, cnt: Record<string, number> = {}; for (const o of opens ?? []) if (o.finder_uid) cnt[o.finder_uid] = (cnt[o.finder_uid] || 0) + 1;
    return json({ place: pl.place_name, note: pl.body, opens_total: (opens ?? []).length, opens_7d: (opens ?? []).filter((o: any) => o.created_at >= since).length, unique: uniq, repeat: Object.values(cnt).filter((n) => n > 1).length, memories: (posts ?? []).map((p: any) => ({ code: p.code, created_at: p.created_at, body: p.body, has_photo: !!p.photo, hidden: p.hidden_by_owner, by: p.spot_profiles?.name ?? null })) });
  }
  if (a === "place_admin") {   // founder only: set the owner's email/notes, read the numbers
    const k = Deno.env.get("QA_KEY"); if (!k || b.key !== k) return json({ error: "no" }, 403);
    const pc = clean(b.code, 12).replace(/[^a-z0-9]/g, ""); const { data: pl } = await db.from("spots").select("*").eq("code", pc).eq("kind", "place").maybeSingle(); if (!pl) return json({ error: "not found" }, 404);
    if (b.approve === true) { await db.from("spots").update({ owner_status: "approved" }).eq("id", pl.id); pl.owner_status = "approved"; }
    if (b.approve === false) { await db.from("spots").update({ owner_status: "rejected" }).eq("id", pl.id); pl.owner_status = "rejected"; }
    if (b.radius_m !== undefined) { const r = Math.min(Math.max(num(b.radius_m) ?? 60, 20), 100000); await db.from("spots").update({ radius_m: r }).eq("id", pl.id); pl.radius_m = r; }
    if (b.owner_email !== undefined || b.owner_note !== undefined) { pl.owner_email = clean(b.owner_email, 120) || pl.owner_email; pl.owner_note = clean(b.owner_note, 300) || pl.owner_note; await db.from("spots").update({ owner_email: pl.owner_email, owner_note: pl.owner_note }).eq("id", pl.id); }
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: opens } = await db.from("spot_finds").select("finder_uid, created_at").eq("spot_id", pl.id);
    const { data: posts } = await db.from("spots").select("code, created_at, maker").eq("place_code", pl.code);
    const uniq = new Set((opens ?? []).map((o: any) => o.finder_uid || "anon")); const repeat = (opens ?? []).reduce((m: any, o: any) => { if (o.finder_uid) m[o.finder_uid] = (m[o.finder_uid] || 0) + 1; return m; }, {});
    return json({ place: pl.place_name, owner_email: pl.owner_email, owner_status: pl.owner_status, claim_note: pl.claim_note, opens_total: (opens ?? []).length, opens_7d: (opens ?? []).filter((o: any) => o.created_at >= since).length, unique_visitors: uniq.size, repeat_visitors: Object.values(repeat).filter((n: any) => n > 1).length, memories_total: (posts ?? []).length, memories_7d: (posts ?? []).filter((p: any) => p.created_at >= since).length });
  }
  if (a === "wall") {   // the memory wall of a shop: everything left here, in full, for someone standing inside
    const pc = clean(b.code, 12).replace(/[^a-z0-9]/g, ""); const { data: pl } = await db.from("spots").select("*, spot_profiles(name, photo)").eq("code", pc).eq("kind", "place").maybeSingle(); if (!pl) return json({ error: "not found" }, 404);
    const lat = num(b.lat), lng = num(b.lng), acc = Math.min(Math.max(num(b.acc) ?? 30, 0), SLACK); if (lat === null || lng === null) return json({ error: "no location" }, 400);
    const dist = metres(lat, lng, pl.lat, pl.lng); if (dist > pl.radius_m + acc) return json({ there: false, distance_m: Math.round(dist), bearing_deg: Math.round(bearing(lat, lng, pl.lat, pl.lng)) });
    const d = 0.0012;
    const { data: near } = await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").neq("kind", "place").gte("lat", pl.lat - d).lte("lat", pl.lat + d).gte("lng", pl.lng - d * 1.5).lte("lng", pl.lng + d * 1.5).limit(80);
    const { data: byCode } = await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").eq("place_code", pl.code).limit(120);
    const seen = new Set<string>(), rows: any[] = [];
    for (const s of [...(byCode ?? []), ...(near ?? [])]) { if (seen.has(s.code) || s.hidden_by_owner) continue; seen.add(s.code); if (s.place_code === pl.code || metres(pl.lat, pl.lng, s.lat, s.lng) <= 30) rows.push(s); }
    rows.sort((x, y) => x.created_at < y.created_at ? 1 : -1);
    const cards = []; for (const s of rows) cards.push({ ...pubSpot(s, { finds: (s.spot_finds ?? []).length }), body: s.body, photo_url: await signedPhoto(db, s.photo), mine: !!user && s.maker === user.id });
    if (user) { const since = new Date(Date.now() - 12 * 3600e3).toISOString(); const { data: recent } = await db.from("spot_finds").select("id").eq("spot_id", pl.id).eq("finder_uid", user.id).gt("created_at", since).limit(1); if (!(recent ?? []).length) { const p = await profile(); await db.from("spot_finds").insert({ spot_id: pl.id, finder_uid: user.id, finder_name: p?.name ?? null, lat, lng }); } }
    else await db.from("spot_finds").insert({ spot_id: pl.id, finder_uid: null, finder_name: null, lat, lng });
    const { data: log } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", pl.id).not("note", "is", null).order("created_at", { ascending: false }).limit(30);
    return json({ there: true, place: { name: pl.place_name, note: pl.body, created_at: pl.created_at, photo_url: await signedPhoto(db, pl.photo) }, cards, logbook: log ?? [] });
  }
  if (a === "here") {   // memories within 80 m of a point: the place page's list
    const lat = num(b.lat), lng = num(b.lng); if (lat === null || lng === null) return json({ error: "no location" }, 400);
    const d = 0.0012;
    const pcode = clean(b.place_code, 12).replace(/[^a-z0-9]/g, "");
    const { data } = await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").neq("kind", "place").gte("lat", lat - d).lte("lat", lat + d).gte("lng", lng - d * 1.5).lte("lng", lng + d * 1.5).order("created_at", { ascending: false }).limit(60);
    const { data: byCode } = pcode ? await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").eq("place_code", pcode).order("created_at", { ascending: false }).limit(60) : { data: [] };
    const seen = new Set<string>(), rows: any[] = [];
    for (const s of [...(byCode ?? []), ...(data ?? [])]) { if (seen.has(s.code) || s.hidden_by_owner) continue; seen.add(s.code); const dm = Math.round(metres(lat, lng, s.lat, s.lng)); if (s.place_code === pcode || dm <= 30) rows.push(pubSpot(s, { distance_m: dm, finds: (s.spot_finds ?? []).length })); }
    const list = rows.sort((x: any, y: any) => x.created_at < y.created_at ? 1 : -1);
    return json({ spots: list });
  }
  if (a === "map") {
    const s0 = num(b.south), w0 = num(b.west), n0 = num(b.north), e0 = num(b.east); if ([s0, w0, n0, e0].some((v) => v === null)) return json({ error: "no bounds" }, 400);
    const now = Date.now(), pin = (s: any, kind: string) => ({ code: s.code, lat: s.lat, lng: s.lng, kind, is_place: s.kind === 'place', place_name: s.place_name || null, place_code: s.place_code || null, clue: s.clue, has_photo: !!s.photo, visibility: s.visibility, finds: (s.spot_finds ?? []).length, maker_name: s.spot_profiles?.name ?? null, created_at: s.created_at, sealed: !!(s.opens_at && new Date(s.opens_at).getTime() > now) });
    const q = () => db.from("spots").select("*, spot_profiles(name), spot_finds(id)").gte("lat", s0!).lte("lat", n0!).gte("lng", w0!).lte("lng", e0!).limit(300);
    const { data: pub } = await q().eq("visibility", "public");
    let mine: any[] = [], shared: any[] = [];
    if (user) { mine = (await q().eq("maker", user.id)).data ?? []; shared = (await q().eq("bound_uid", user.id).neq("visibility", "hidden")).data ?? []; }
    const seen = new Set<string>(), out: any[] = [];
    for (const s of mine) { seen.add(s.code); out.push(pin(s, "mine")); }
    for (const s of shared) if (!seen.has(s.code)) { seen.add(s.code); out.push(pin(s, "shared")); }
    for (const s of pub ?? []) if (!seen.has(s.code)) { seen.add(s.code); out.push(pin(s, "public")); }
    return json({ pins: out, counts: { public: (pub ?? []).length, mine: mine.length, shared: shared.length } });
  }

  const c = clean(b.code, 12).replace(/[^a-z0-9]/g, "");
  const { data: s } = c ? await db.from("spots").select("*, spot_profiles(name, photo)").eq("code", c).maybeSingle() : { data: null };
  if (!s) return json({ error: "not found" }, 404);
  const isMaker = !!user && user.id === s.maker;

  if (a === "toggle") {
    if (!isMaker) return json({ error: "not yours" }, 403);
    const vis = ["personal", "link", "public", "hidden"].includes(b.visibility) ? b.visibility : null; if (!vis) return json({ error: "bad visibility" }, 400);
    await db.from("spots").update({ visibility: vis }).eq("id", s.id); return json({ ok: true, visibility: vis });
  }
  if ((s.visibility === "hidden" || s.visibility === "personal") && !isMaker) return json({ error: "not found" }, 404);
  if (s.visibility === "link" && !isMaker) {
    if (!user) return json({ error: "sign in", need_signin: true, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null }, 401);
    if (!s.bound_uid) { await db.from("spots").update({ bound_uid: user.id }).eq("id", s.id); s.bound_uid = user.id; }
    else if (s.bound_uid !== user.id) return json({ error: "This one was buried for someone else" }, 403);
  }

  if (a === "peek") {
    const { count } = await db.from("spot_finds").select("id", { count: "exact", head: true }).eq("spot_id", s.id);
    return json(pubSpot(s, { lat: s.lat, lng: s.lng, finds: count ?? 0, is_maker: isMaker, is_owner: isOwner(s, user), claim_status: s.owner_status || null, bound: !!s.bound_uid, mine_bound: !!user && s.bound_uid === user.id }));
  }

  // open and reply both need the finder to be standing there
  const lat = num(b.lat), lng = num(b.lng), acc = Math.min(Math.max(num(b.acc) ?? 30, 0), SLACK);
  if (lat === null || lng === null) return json({ error: "no location" }, 400);
  const dist = metres(lat, lng, s.lat, s.lng), there = isMaker || dist <= s.radius_m + acc;
  if (a === "open") {
    if (s.opens_at && new Date(s.opens_at).getTime() > Date.now()) return json({ sealed: true, opens_at: s.opens_at, distance_m: Math.round(dist) });
    if (!there) return json({ there: false, distance_m: Math.round(dist), bearing_deg: Math.round(bearing(lat, lng, s.lat, s.lng)) });
    if (!isMaker) {
      const p = user ? await profile() : null;
      const { data: already } = user ? await db.from("spot_finds").select("id").eq("spot_id", s.id).eq("finder_uid", user.id).limit(1) : { data: [] };
      if (!(already ?? []).length) await db.from("spot_finds").insert({ spot_id: s.id, finder_uid: user?.id ?? null, finder_name: p?.name ?? null, lat, lng });
    }
    const { data: finds } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", s.id).order("created_at", { ascending: false }).limit(50);
    return json({ there: true, distance_m: Math.round(dist), body: s.body, photo_url: await signedPhoto(db, s.photo), buried_at: s.created_at, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null, logbook: finds ?? [], is_maker: isMaker });
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
