// That spot: bury a message at a place; it opens only for someone standing there (within the radius, plus GPS slack).
// Makers must be signed in (Google via Supabase auth; the user's JWT comes in the Authorization header). Finding a
// public or link drop needs no account. Text is checked by Claude Haiku before anyone can open it (fail-closed for makers).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
import { ownerReportHtml, ownerReportText, type WeekReport } from "./report_mail.ts";

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
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#1d2433"><p style="font-size:22px;margin:0 0 6px">📍 Memspots</p><p style="font-size:16px;line-height:1.5;white-space:pre-line">${esc(body)}</p><p><a href="${url}" style="display:inline-block;background:#e8b84b;color:#2a2418;font-weight:800;padding:12px 18px;border-radius:999px;text-decoration:none">${esc(cta)}</a></p><p style="font-size:12px;color:#6b7387;margin-top:28px">You asked for this at voterpup.com/myspot. <a href="${unsub}" style="color:#6b7387">Unsubscribe</a> · <a href="${SITE}/myspot/privacy.html" style="color:#6b7387">Privacy</a></p></div>`;
  await mailRaw(to, subject, html, `${body}\n\n${cta}: ${url}\n\nUnsubscribe: ${unsub}`, unsub);
}
async function mailRaw(to: string, subject: string, html: string, text: string, unsub: string) {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key) throw new Error("no RESEND_API_KEY");
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ from: "Memspots <pup@voterpup.com>", to: [to], subject, html, text, headers: { "List-Unsubscribe": `<${unsub}>` } }) });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 160));
}
async function sha256hex(s: string) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, "0")).join(""); }
// who is hearting: the account, or a hash of the random device number the page made (never the number itself, never a location)
async function heartWho(user: any, dev: unknown) { if (user) return "u:" + user.id; const d = String(dev ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 32); return d ? "d:" + (await sha256hex(d)) : null; }
async function heartsFor(db: any, ids: number[], who: string | null) {   // counts per spot id, and which ones `who` hearted
  const count: Record<number, number> = {}, mine = new Set<number>(); if (!ids.length) return { count, mine };
  const { data } = await db.from("spot_hearts").select("spot_id, who").in("spot_id", ids).limit(5000);
  for (const h of data ?? []) { count[h.spot_id] = (count[h.spot_id] || 0) + 1; if (who && h.who === who) mine.add(h.spot_id); }
  return { count, mine };
}
// a memory left inside a shop opens anywhere inside the shop, not only within 40 m of where its maker stood
async function placeOf(db: any, s: any) { if (!s.place_code) return null; const { data } = await db.from("spots").select("lat, lng, radius_m").eq("code", s.place_code).eq("kind", "place").maybeSingle(); return data ?? null; }
// the owner's weekly numbers; null when the owner unsubscribed. One spot_subs row per owner email and shop carries the unsubscribe token.
async function weekReport(db: any, pl: any): Promise<WeekReport | null> {
  const em = String(pl.owner_email).toLowerCase();
  let { data: sub } = await db.from("spot_subs").select("token, unsub_at").eq("email", em).eq("kind", "owner_weekly").eq("spot_code", pl.code).maybeSingle();
  if (!sub) { const ins = await db.from("spot_subs").insert({ email: em, kind: "owner_weekly", spot_code: pl.code, token: tokenOf() }).select("token, unsub_at").single(); sub = ins.data; }
  if (!sub || sub.unsub_at) return null;
  const now = Date.now(), s7 = new Date(now - 7 * 864e5).toISOString(), s14 = new Date(now - 14 * 864e5).toISOString();
  const { data: opens } = await db.from("spot_finds").select("finder_uid, created_at").eq("spot_id", pl.id).limit(20000);
  const { data: posts0 } = await db.from("spots").select("id, body, photo, created_at, hidden_by_owner, awaiting_owner, spot_profiles(name)").eq("place_code", pl.code).eq("visibility", "public").limit(5000);
  const posts = (posts0 ?? []).filter((p: any) => !p.awaiting_owner);
  const ids = (posts ?? []).map((p: any) => p.id);
  const { data: hearts } = ids.length ? await db.from("spot_hearts").select("spot_id, created_at").in("spot_id", ids).limit(20000) : { data: [] };
  const hc: Record<number, number> = {}; for (const h of hearts ?? []) hc[h.spot_id] = (hc[h.spot_id] || 0) + 1;
  const o = opens ?? [], p = posts ?? [], wk = (rows: any[], a: string, z?: string) => rows.filter((r) => r.created_at >= a && (!z || r.created_at < z));
  const cnt: Record<string, number> = {}; for (const x of o) if (x.finder_uid) cnt[x.finder_uid] = (cnt[x.finder_uid] || 0) + 1;
  const week = wk(p, s7).filter((m: any) => !m.hidden_by_owner).sort((x: any, y: any) => (hc[y.id] || 0) - (hc[x.id] || 0) || (x.created_at < y.created_at ? 1 : -1)).slice(0, 3);
  await db.from("spot_subs").update({ last_sent: new Date().toISOString() }).eq("token", sub.token);
  return { place: pl.place_name, week_start: s7.slice(0, 10), week_end: new Date(now - 864e5).toISOString().slice(0, 10),
    opens_7d: wk(o, s7).length, opens_prev: wk(o, s14, s7).length, memories_7d: wk(p, s7).length, memories_prev: wk(p, s14, s7).length,
    photos_7d: wk(p, s7).filter((m: any) => m.photo).length, hearts_7d: wk(hearts ?? [], s7).length,
    opens_total: o.length, memories_total: p.length, unique_total: new Set(o.map((x: any) => x.finder_uid || "anon")).size, repeat_total: Object.values(cnt).filter((n) => n > 1).length,
    top: week.map((m: any) => ({ body: m.body || null, has_photo: !!m.photo, by: m.spot_profiles?.name ?? null, hearts: hc[m.id] || 0, created_at: m.created_at })),
    wall_url: `${SITE}/myspot/?at=${pl.code}`, unsub_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/thatspot?unsub=${sub.token}`, privacy_url: `${SITE}/myspot/privacy.html` };
}
// a short email to the shop owner (approved owners only). It rides on the same unsubscribe as the Monday report: an owner who opted out hears nothing.
async function ownerMail(db: any, pl: any, subject: string, body: string, cta: string) {
  if (pl.owner_status !== "approved" || !pl.owner_email) return;
  const em = String(pl.owner_email).toLowerCase();
  let { data: sub } = await db.from("spot_subs").select("token, unsub_at").eq("email", em).eq("kind", "owner_weekly").eq("spot_code", pl.code).maybeSingle();
  if (!sub) { const ins = await db.from("spot_subs").insert({ email: em, kind: "owner_weekly", spot_code: pl.code, token: tokenOf() }).select("token, unsub_at").single(); sub = ins.data; }
  if (!sub || sub.unsub_at) return;
  try { await mail(em, subject, body, cta, `${SITE}/myspot/?at=${pl.code}`, `${Deno.env.get("SUPABASE_URL")}/functions/v1/thatspot?unsub=${sub.token}`); } catch (e) { await logFail("owner mail", e); }
}
const tokenOf = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
function isOwner(s: any, user: any) { return !!user && s.owner_status === "approved" && ((s.owner_uid && s.owner_uid === user.id) || (s.owner_email && user.email && s.owner_email.toLowerCase() === String(user.email).toLowerCase())); }
async function setLogo(db: any, pl: any, b64: unknown) {
  const m = typeof b64 === "string" ? b64.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/) : null; if (!m || m[1].length > 1_200_000) return "logo too big";
  const bytes = Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0)), path = "spots/" + pl.code + ".logo." + Date.now() + ".jpg";
  const up = await db.storage.from("media").upload(path, bytes, { contentType: "image/jpeg", upsert: false }); if (up.error) return "upload failed";
  if (!(await photoOk(db, path))) { await db.storage.from("media").remove([path]); return "That picture didn't pass our safety check"; }
  if (pl.logo) await db.storage.from("media").remove([pl.logo]);
  await db.from("spots").update({ logo: path }).eq("id", pl.id); return null;
}
function pubSpot(s: any, extra: Record<string, unknown> = {}) {
  return { code: s.code, kind: s.kind || 'memory', place_name: s.place_name || null, enc: !!s.enc, clue: s.clue, visibility: s.visibility, opens_at: s.opens_at, created_at: s.created_at, radius_m: s.radius_m, has_photo: !!s.photo, pinned: !!s.pinned_by_owner, maker_name: s.kind === "place" ? (s.place_name || null) : (s.spot_profiles?.name ?? null), maker_photo: s.kind === "place" ? null : (s.spot_profiles?.photo ?? null), ...extra };   // a shop's spot speaks as the shop, not as whoever set it up
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
          const { data: sp } = await db.from("spots").select("id, code, body, enc, place_code, place_name").eq("code", sub.spot_code).maybeSingle(); if (!sp) continue;
          const { data: f } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", sp.id).gt("created_at", since).neq("finder_uid", sub.uid ?? "00000000-0000-0000-0000-000000000000");
          const opens = (f ?? []).length, notes = (f ?? []).filter((x: any) => x.note);
          if (!opens) continue;
          text = `${opens === 1 ? "Someone" : opens + " people"} opened your ${sp.enc ? "private memory" : "memory \"" + String(sp.body || "").slice(0, 60) + "\""}` + (notes.length ? `, and ${notes.length === 1 ? "one left a note" : notes.length + " left notes"}: "${String(notes[0].note).slice(0, 80)}"` : "") + ".";
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
    if (now.getUTCDay() === 1 || b.force_owners === Deno.env.get("QA_KEY")) {   // Monday: the shops' weekly report (verified owners only)
      const { data: places } = await db.from("spots").select("*").eq("kind", "place").eq("owner_status", "approved").not("owner_email", "is", null);
      for (const pl of places ?? []) {
        try {
          const r = await weekReport(db, pl); if (!r) continue;
          await mailRaw(pl.owner_email, "📍 " + pl.place_name + ": your week on the memory wall", ownerReportHtml(r), ownerReportText(r), r.unsub_url); owners++;
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
      await mail(em, "Your Memspots code: " + g.properties.email_otp, "Your sign-in code is " + g.properties.email_otp + ". It works for a few minutes. If you didn't ask for it, ignore this email.", "Open Memspots", SITE + "/myspot/", SITE + "/myspot/privacy.html");
    } catch (e) { await logFail("thatspot otp mail", e); return json({ error: "could not send the email" }, 500); }
    return json({ ok: true });
  }
  if (a === "me") { const p = await profile(); let h = 0; for (const ch of String(user?.id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return json({ profile: p ? { name: p.name, photo: p.photo, color: h % 12 } : null }); }
  if (a === "rename") { const p = await profile(); if (!p) return json({ error: "sign in" }, 401); const name = clean(b.name, 40); if (!name) return json({ error: "missing" }, 400); await db.from("spot_profiles").update({ name }).eq("uid", user.id); return json({ ok: true }); }

  if (a === "bury") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    const lat = num(b.lat), lng = num(b.lng), clue = clean(b.clue, 140) || null;
    if (b.enc === true && (b.visibility === "public" || b.kind === "place")) return json({ error: "public memories are not encrypted" }, 400);
    const isPlace = b.kind === "place", placeName = clean(b.place_name, 60) || null;
    if (isPlace && !clean(b.body, 600)) b.body = "Welcome to " + placeName + ". Leave something here for the next person.";
    if (isPlace && !placeName) return json({ error: "shop name missing" }, 400);
    const vis = isPlace ? "public" : ["personal", "link", "public"].includes(b.visibility) ? b.visibility : "link";
    const body = b.enc === true ? String(b.body ?? "").replace(/[^A-Za-z0-9+/=:]/g, "").slice(0, 4000) : clean(b.body, 600);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json({ error: "no location" }, 400);
    if (!body && !isPlace && !(typeof b.photo_b64 === "string" && b.photo_b64.length)) return json({ error: "missing" }, 400);
    let placeCode: string | null = null, shop: any = null;
    if (!isPlace && typeof b.place_code === "string" && b.place_code) {
      const pc = clean(b.place_code, 12).replace(/[^a-z0-9]/g, "");
      const { data: pl } = await db.from("spots").select("*").eq("code", pc).eq("kind", "place").maybeSingle();
      if (!pl) return json({ error: "no such shop" }, 404);
      const dpl = metres(lat, lng, pl.lat, pl.lng), accpl = Math.min(Math.max(num(b.acc) ?? 30, 0), SLACK);
      if (dpl > pl.radius_m + accpl) return json({ error: "You need to be at the shop to post here (you're " + Math.round(dpl) + " m away)" }, 400);
      placeCode = pl.code; shop = pl;
      // a photo on a shop's wall: the poster confirms everyone in it is okay with that (a parent or guardian for a child). The page shows the line next to the button.
      if (typeof b.photo_b64 === "string" && b.photo_b64.length && b.consent !== true) return json({ error: "Please confirm everyone in the photo is okay with it being on the wall." }, 400);
    }
    const awaiting = !!shop?.approve_first;   // the shop approves posts before they show
    let opens: string | null = null;
    if (b.opens_at) { const t = new Date(b.opens_at); if (isNaN(t.getTime())) return json({ error: "bad time" }, 400); opens = t.toISOString(); }
    const enc = b.enc === true && !isPlace && (vis === "personal" || vis === "link");   // ciphertext: nothing to check except the plaintext clue
    const chk = await textOk((enc ? "" : body) + (clue ? "\n" + clue : "") + (placeName ? "\n" + placeName : "")); if (!chk.ok) return json({ error: "That didn't pass our safety check" + (chk.why ? " (" + chk.why + ")" : "") }, 422);
    const c = code();
    let photoPath: string | null = null;
    if (enc && typeof b.photo_enc_b64 === "string" && b.photo_enc_b64.length) {
      if (!/^[A-Za-z0-9+/=]+$/.test(b.photo_enc_b64) || b.photo_enc_b64.length > 2_300_000) return json({ error: "photo too big" }, 413);
      const bytes = Uint8Array.from(atob(b.photo_enc_b64), (ch) => ch.charCodeAt(0)); photoPath = "spots/" + c + ".enc.jpg";   // ciphertext; the bucket only accepts image types, and nobody can render it anyway
      const up = await db.storage.from("media").upload(photoPath, bytes, { contentType: "image/jpeg", upsert: false });
      if (up.error) { await logFail("thatspot upload", up.error); return json({ error: "photo upload failed" }, 500); }
    } else if (typeof b.photo_b64 === "string" && b.photo_b64.length) {
      const m = b.photo_b64.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/); if (!m || m[1].length > 2_200_000) return json({ error: "photo too big" }, 413);
      const bytes = Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0)); photoPath = "spots/" + c + ".jpg";
      const up = await db.storage.from("media").upload(photoPath, bytes, { contentType: "image/jpeg", upsert: false });
      if (up.error) { await logFail("thatspot upload", up.error); return json({ error: "photo upload failed" }, 500); }
      if (!(await photoOk(db, photoPath))) { await db.storage.from("media").remove([photoPath]); return json({ error: "That photo didn't pass our safety check" }, 422); }
    }
    const { error } = await db.from("spots").insert({ code: c, maker: user.id, lat, lng, body, clue, photo: photoPath, visibility: vis, opens_at: opens, kind: isPlace ? "place" : "memory", place_name: placeName, place_code: placeCode, radius_m: isPlace ? 60 : 40, enc, src: clean(b.src, 24) || null,
      awaiting_owner: awaiting, photo_consent_at: photoPath && placeCode && b.consent === true ? new Date().toISOString() : null });
    if (error) { await logFail("thatspot bury", error); return json({ error: "db: " + error.message }, 500); }
    if (awaiting) await ownerMail(db, shop, "📍 A memory is waiting for your OK at " + shop.place_name, (p.name || "A guest") + " left a memory on your wall" + (photoPath ? ", with a photo" : "") + (body ? ":\n\n“" + body.slice(0, 200) + (body.length > 200 ? "…" : "") + "”" : ".") + "\n\nIt shows to guests once you approve it, from your owner panel.", "Open your panel");
    return json({ code: c, awaiting });
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
    try { await mail("hi@voterpup.com", "Shop claim: " + pl.place_name, `${name} <${em}> claims ${pl.place_name} (code ${pl.code}).\n\n${note}\n\nApprove with place_admin approve:true once verified.`, "Open the shop", SITE + "/myspot/?at=" + pl.code, SITE + "/myspot/privacy.html"); } catch (e) { await logFail("claim mail", e); }
    return json({ ok: true, status: "pending" });
  }
  if (a === "owner_stats" || a === "owner_export" || a === "owner_hide" || a === "owner_pin" || a === "owner_approve" || a === "owner_remove" || a === "owner_settings" || a === "owner_note" || a === "owner_logo") {
    const pc = clean(b.code, 12).replace(/[^a-z0-9]/g, ""); const { data: pl } = await db.from("spots").select("*").eq("code", pc).eq("kind", "place").maybeSingle(); if (!pl) return json({ error: "not found" }, 404);
    if (!isOwner(pl, user)) return json({ error: "not the owner" }, 403);
    if (a === "owner_logo") { const err = await setLogo(db, pl, b.photo_b64); return err ? json({ error: err }, 422) : json({ ok: true }); }
    if (a === "owner_note") { const body = clean(b.body, 600); if (!body) return json({ error: "missing" }, 400); const chk = await textOk(body); if (!chk.ok) return json({ error: "That didn't pass our safety check" }, 422); await db.from("spots").update({ body }).eq("id", pl.id); return json({ ok: true }); }
    if (a === "owner_export") {   // the whole wall as the guests see it, with photo links, for the PDF or PowerPoint the page builds; no location needed, the owner may be at home
      const { data: posts } = await db.from("spots").select("id, code, created_at, body, photo, pinned_by_owner, spot_profiles(name)").eq("place_code", pl.code).eq("visibility", "public").eq("hidden_by_owner", false).eq("awaiting_owner", false).order("created_at", { ascending: false }).limit(500);
      const hearts = await heartsFor(db, (posts ?? []).map((p: any) => p.id), null), cards = [];
      for (const p of posts ?? []) cards.push({ code: p.code, body: p.body, photo_url: await signedPhoto(db, p.photo), maker_name: p.spot_profiles?.name ?? null, created_at: p.created_at, hearts: hearts.count[p.id] || 0, pinned: !!p.pinned_by_owner });
      return json({ place: pl.place_name, cards });
    }
    if (a === "owner_settings") {   // "Approve posts first": new posts wait in the panel until the owner says yes
      await db.from("spots").update({ approve_first: b.approve_first === true }).eq("id", pl.id); return json({ ok: true, approve_first: b.approve_first === true });
    }
    if (a === "owner_hide" || a === "owner_pin" || a === "owner_approve" || a === "owner_remove") {   // hide: off the wall, undoable · pin: at the top · approve: out of the waiting list · remove: gone for good, photo included
      const mc = clean(b.memory, 12).replace(/[^a-z0-9]/g, ""); const { data: m } = await db.from("spots").select("id, code, place_code, photo").eq("code", mc).maybeSingle(); if (!m || m.place_code !== pl.code) return json({ error: "not on your wall" }, 400);
      if (a === "owner_remove") { if (m.photo) await db.storage.from("media").remove([m.photo]); await db.from("spot_subs").delete().eq("spot_code", m.code); await db.from("spots").delete().eq("id", m.id); return json({ ok: true }); }
      await db.from("spots").update(a === "owner_hide" ? { hidden_by_owner: b.hidden !== false } : a === "owner_pin" ? { pinned_by_owner: b.pinned !== false } : { awaiting_owner: false }).eq("id", m.id); return json({ ok: true });
    }
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: opens } = await db.from("spot_finds").select("finder_uid, created_at").eq("spot_id", pl.id);
    const { data: posts } = await db.from("spots").select("id, code, created_at, body, photo, hidden_by_owner, pinned_by_owner, awaiting_owner, spot_profiles(name)").eq("place_code", pl.code).eq("visibility", "public").order("created_at", { ascending: false }).limit(100);
    const hearts = await heartsFor(db, (posts ?? []).map((p: any) => p.id), null);
    const uniq = new Set((opens ?? []).map((o: any) => o.finder_uid || "anon")).size, cnt: Record<string, number> = {}; for (const o of opens ?? []) if (o.finder_uid) cnt[o.finder_uid] = (cnt[o.finder_uid] || 0) + 1;
    return json({ place: pl.place_name, note: pl.body, approve_first: !!pl.approve_first, opens_total: (opens ?? []).length, opens_7d: (opens ?? []).filter((o: any) => o.created_at >= since).length, unique: uniq, repeat: Object.values(cnt).filter((n) => n > 1).length, memories: (posts ?? []).map((p: any) => ({ code: p.code, created_at: p.created_at, body: p.body, has_photo: !!p.photo, hidden: p.hidden_by_owner, pinned: p.pinned_by_owner, awaiting: !!p.awaiting_owner, hearts: hearts.count[p.id] || 0, by: p.spot_profiles?.name ?? null })) });
  }
  if (a === "activity") {   // founder only: who did what in My spot (QA accounts excluded)
    const k = Deno.env.get("QA_KEY"); if (!k || b.key !== k) return json({ error: "no" }, 403);
    const since = b.since || new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: users } = await db.auth.admin.listUsers({ perPage: 500 });
    const emailOf = new Map((users?.users ?? []).map((u: any) => [u.id, u.email]));
    const isQa = (uid: string | null) => !!uid && String(emailOf.get(uid) || "").endsWith("@voterpup.test");
    const { data: profs } = await db.from("spot_profiles").select("uid, name, created_at").order("created_at", { ascending: false });
    const { data: made } = await db.from("spots").select("code, kind, place_name, visibility, enc, created_at, maker, place_code, src").gt("created_at", since).order("created_at", { ascending: false }).limit(200);
    const { data: finds } = await db.from("spot_finds").select("spot_id, finder_uid, finder_name, note, created_at").gt("created_at", since).order("created_at", { ascending: false }).limit(300);
    const { data: ev } = await db.from("events").select("ts, dev, meta, src").eq("event", "spot").gt("ts", since).order("ts", { ascending: false }).limit(3000);
    const { data: subs } = await db.from("spot_subs").select("email, kind, spot_code, created_at").gt("created_at", since);
    const steps: Record<string, number> = {}; const devs = new Set<string>(); for (const e of ev ?? []) { steps[e.meta?.step] = (steps[e.meta?.step] || 0) + 1; devs.add(e.dev); }
    return json({
      profiles: (profs ?? []).filter((p: any) => !isQa(p.uid)).map((p: any) => ({ name: p.name, email: emailOf.get(p.uid), joined: p.created_at })),
      made: (made ?? []).filter((s: any) => !isQa(s.maker)).map((s: any) => ({ when: s.created_at, by: emailOf.get(s.maker), kind: s.kind, place: s.place_name, vis: s.visibility, enc: s.enc, at_shop: s.place_code, src: s.src })),
      opens: (finds ?? []).filter((f: any) => !isQa(f.finder_uid)).map((f: any) => ({ when: f.created_at, by: f.finder_uid ? emailOf.get(f.finder_uid) : "anonymous", note: f.note })),
      subs: subs ?? [], devices: devs.size, steps,
    });
  }
  if (a === "place_admin") {   // founder only: set the owner's email/notes, read the numbers
    const k = Deno.env.get("QA_KEY"); if (!k || b.key !== k) return json({ error: "no" }, 403);
    const pc = clean(b.code, 12).replace(/[^a-z0-9]/g, ""); const { data: pl } = await db.from("spots").select("*").eq("code", pc).eq("kind", "place").maybeSingle(); if (!pl) return json({ error: "not found" }, 404);
    if (b.logo_b64) { const err = await setLogo(db, pl, b.logo_b64); if (err) return json({ error: err }, 422); }
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
    const owner = isOwner(pl, user), seen = new Set<string>(), rows: any[] = [];   // the owner also sees what they hid and what is waiting, marked; the maker sees their own waiting post
    for (const s of [...(byCode ?? []), ...(near ?? [])]) { if (seen.has(s.code) || (s.hidden_by_owner && !owner) || (s.awaiting_owner && !owner && !(user && s.maker === user.id))) continue; seen.add(s.code); if (s.place_code === pl.code || metres(pl.lat, pl.lng, s.lat, s.lng) <= 30) rows.push(s); }
    rows.sort((x, y) => (y.pinned_by_owner ? 1 : 0) - (x.pinned_by_owner ? 1 : 0) || (x.created_at < y.created_at ? 1 : -1));   // pinned first, then newest
    const who = await heartWho(user, b.dev), hearts = await heartsFor(db, rows.map((s) => s.id), who);
    const cards = []; for (const s of rows) cards.push({ ...pubSpot(s, { finds: (s.spot_finds ?? []).length }), body: s.body, photo_url: await signedPhoto(db, s.photo), mine: !!user && s.maker === user.id, hearts: hearts.count[s.id] || 0, hearted: hearts.mine.has(s.id), hidden: owner && !!s.hidden_by_owner, awaiting: !!s.awaiting_owner });
    // an open is counted, never located: no coordinates are stored (the finder's position was only compared, above)
    if (user) { const since = new Date(Date.now() - 12 * 3600e3).toISOString(); const { data: recent } = await db.from("spot_finds").select("id").eq("spot_id", pl.id).eq("finder_uid", user.id).gt("created_at", since).limit(1); if (!(recent ?? []).length) { const p = await profile(); await db.from("spot_finds").insert({ spot_id: pl.id, finder_uid: user.id, finder_name: p?.name ?? null }); } }
    else await db.from("spot_finds").insert({ spot_id: pl.id, finder_uid: null, finder_name: null });
    const { data: log } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", pl.id).not("note", "is", null).order("created_at", { ascending: false }).limit(30);
    const { count: visitors } = await db.from("spot_finds").select("id", { count: "exact", head: true }).eq("spot_id", pl.id);
    return json({ there: true, place: { name: pl.place_name, note: pl.body, created_at: pl.created_at, photo_url: await signedPhoto(db, pl.photo), logo_url: await signedPhoto(db, pl.logo), opens: visitors ?? 0, is_owner: owner }, cards, logbook: log ?? [] });
  }
  if (a === "here") {   // memories within 80 m of a point: the place page's list
    const lat = num(b.lat), lng = num(b.lng); if (lat === null || lng === null) return json({ error: "no location" }, 400);
    const d = 0.0012;
    const pcode = clean(b.place_code, 12).replace(/[^a-z0-9]/g, "");
    const { data } = await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").neq("kind", "place").gte("lat", lat - d).lte("lat", lat + d).gte("lng", lng - d * 1.5).lte("lng", lng + d * 1.5).order("created_at", { ascending: false }).limit(60);
    const { data: byCode } = pcode ? await db.from("spots").select("*, spot_profiles(name, photo), spot_finds(id)").eq("visibility", "public").eq("place_code", pcode).order("created_at", { ascending: false }).limit(60) : { data: [] };
    const seen = new Set<string>(), rows: any[] = [];
    for (const s of [...(byCode ?? []), ...(data ?? [])]) { if (seen.has(s.code) || s.hidden_by_owner || s.awaiting_owner) continue; seen.add(s.code); const dm = Math.round(metres(lat, lng, s.lat, s.lng)); if (s.place_code === pcode || dm <= 30) rows.push(pubSpot(s, { distance_m: dm, finds: (s.spot_finds ?? []).length })); }
    const list = rows.sort((x: any, y: any) => x.created_at < y.created_at ? 1 : -1);
    return json({ spots: list });
  }
  if (a === "map") {
    const s0 = num(b.south), w0 = num(b.west), n0 = num(b.north), e0 = num(b.east); if ([s0, w0, n0, e0].some((v) => v === null)) return json({ error: "no bounds" }, 400);
    const colorOf = (uid: string) => { let h = 0; for (const ch of String(uid || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 12; };   // each person gets a stable colour, without exposing who they are
    const now = Date.now(), pin = (s: any, kind: string) => ({ code: s.code, lat: s.lat, lng: s.lng, kind, color: colorOf(s.maker), is_place: s.kind === 'place', place_name: s.place_name || null, place_code: s.place_code || null, clue: s.clue, has_photo: !!s.photo, visibility: s.visibility, finds: (s.spot_finds ?? []).length, maker_name: s.spot_profiles?.name ?? null, created_at: s.created_at, sealed: !!(s.opens_at && new Date(s.opens_at).getTime() > now) });
    const q = () => db.from("spots").select("*, spot_profiles(name), spot_finds(id)").gte("lat", s0!).lte("lat", n0!).gte("lng", w0!).lte("lng", e0!).limit(300);
    const { data: pub } = await q().eq("visibility", "public");
    let mine: any[] = [], shared: any[] = [];
    if (user) { mine = (await q().eq("maker", user.id)).data ?? []; shared = (await q().eq("bound_uid", user.id).neq("visibility", "hidden")).data ?? []; }
    const seen = new Set<string>(), out: any[] = [];
    for (const s of mine) { seen.add(s.code); out.push(pin(s, "mine")); }
    for (const s of shared) if (!seen.has(s.code)) { seen.add(s.code); out.push(pin(s, "shared")); }
    for (const s of pub ?? []) if (!seen.has(s.code)) { seen.add(s.code); out.push(pin(s, "public")); }
    const logoPaths = [...mine, ...shared, ...(pub ?? [])].filter((s: any) => s.kind === "place" && s.logo).map((s: any) => s.logo);
    if (logoPaths.length) { const { data: signed } = await db.storage.from("media").createSignedUrls([...new Set(logoPaths)], 3600); const byPath = new Map((signed ?? []).map((x: any) => [x.path, x.signedUrl])); const byCode = new Map([...mine, ...shared, ...(pub ?? [])].filter((s: any) => s.logo).map((s: any) => [s.code, byPath.get(s.logo)])); for (const p of out) if (p.is_place && byCode.get(p.code)) p.logo_url = byCode.get(p.code); }
    return json({ pins: out, counts: { public: (pub ?? []).length, mine: mine.length, shared: shared.length } });
  }

  const c = clean(b.code, 12).replace(/[^a-z0-9]/g, "");
  const { data: s } = c ? await db.from("spots").select("*, spot_profiles(name, photo)").eq("code", c).maybeSingle() : { data: null };
  if (!s) return json({ error: "not found" }, 404);
  const isMaker = !!user && user.id === s.maker;

  if (a === "delete") {   // the maker deletes a memory for good: photo, finds, email opt-ins, row
    if (!isMaker) return json({ error: "not yours" }, 403);
    if (s.kind === "place") return json({ error: "A shop spot is removed by hi@voterpup.com, not deleted here." }, 400);
    if (s.photo) await db.storage.from("media").remove([s.photo]);
    await db.from("spot_subs").delete().eq("spot_code", s.code);
    await db.from("spots").delete().eq("id", s.id);   // spot_finds cascade
    if (s.place_code) {   // the shop hears about it: the post and its photo are gone from the wall and from our storage
      const { data: shop } = await db.from("spots").select("*").eq("code", s.place_code).eq("kind", "place").maybeSingle();
      if (shop) await ownerMail(db, shop, "📍 A guest removed their memory from " + shop.place_name, (s.spot_profiles?.name || "A guest") + " deleted their memory" + (s.photo ? " and its photo" : "") + " from your wall" + (s.body ? ":\n\n“" + String(s.body).slice(0, 200) + (s.body.length > 200 ? "…" : "") + "”" : ".") + "\n\nIt is gone for good, from the wall and from our storage.", "Open your wall");
    }
    return json({ ok: true });
  }
  if (a === "toggle") {
    if (!isMaker) return json({ error: "not yours" }, 403);
    const vis = ["personal", "link", "public", "hidden"].includes(b.visibility) ? b.visibility : null; if (!vis) return json({ error: "bad visibility" }, 400);
    if (s.enc && vis === "public") return json({ error: "An encrypted memory can't be made public. Leave a new public one instead." }, 400);
    await db.from("spots").update({ visibility: vis }).eq("id", s.id); return json({ ok: true, visibility: vis });
  }
  if ((s.visibility === "hidden" || s.visibility === "personal" || s.awaiting_owner) && !isMaker) return json({ error: "not found" }, 404);
  if (s.visibility === "link" && !isMaker) {
    if (!user) return json({ error: "sign in", need_signin: true, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null }, 401);
    if (!s.bound_uid) { await db.from("spots").update({ bound_uid: user.id }).eq("id", s.id); s.bound_uid = user.id; }
    else if (s.bound_uid !== user.id) return json({ error: "This one was buried for someone else" }, 403);
  }

  if (a === "peek") {
    const { count } = await db.from("spot_finds").select("id", { count: "exact", head: true }).eq("spot_id", s.id);
    return json(pubSpot(s, { lat: s.lat, lng: s.lng, logo_url: s.kind === "place" ? await signedPhoto(db, s.logo) : null, finds: count ?? 0, is_maker: isMaker, is_owner: isOwner(s, user), claim_status: s.owner_status || null, bound: !!s.bound_uid, mine_bound: !!user && s.bound_uid === user.id }));
  }

  // open and reply both need the finder to be standing there
  const lat = num(b.lat), lng = num(b.lng), acc = Math.min(Math.max(num(b.acc) ?? 30, 0), SLACK);
  if (lat === null || lng === null) return json({ error: "no location" }, 400);
  const dist = metres(lat, lng, s.lat, s.lng), pl = await placeOf(db, s);
  const there = isMaker || dist <= s.radius_m + acc || (!!pl && metres(lat, lng, pl.lat, pl.lng) <= pl.radius_m + acc);   // inside the shop counts for anything left at the shop
  if (a === "heart") {   // one heart per person per memory; stored as who + when, never where
    if (!there) return json({ error: "You need to be there" }, 400);
    const who = await heartWho(user, b.dev); if (!who) return json({ error: "no device" }, 400);
    if (b.on === false) await db.from("spot_hearts").delete().eq("spot_id", s.id).eq("who", who); else await db.from("spot_hearts").upsert({ spot_id: s.id, who }, { onConflict: "spot_id,who", ignoreDuplicates: true });
    const { count } = await db.from("spot_hearts").select("spot_id", { count: "exact", head: true }).eq("spot_id", s.id);
    return json({ ok: true, hearts: count ?? 0, hearted: b.on !== false });
  }
  if (a === "open") {
    if (s.opens_at && new Date(s.opens_at).getTime() > Date.now()) return json({ sealed: true, opens_at: s.opens_at, distance_m: Math.round(dist) });
    if (!there) return json({ there: false, distance_m: Math.round(dist), bearing_deg: Math.round(bearing(lat, lng, s.lat, s.lng)) });
    if (!isMaker) {   // counted, never located
      const p = user ? await profile() : null;
      const { data: already } = user ? await db.from("spot_finds").select("id").eq("spot_id", s.id).eq("finder_uid", user.id).limit(1) : { data: [] };
      if (!(already ?? []).length) await db.from("spot_finds").insert({ spot_id: s.id, finder_uid: user?.id ?? null, finder_name: p?.name ?? null });
    }
    const { data: finds } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", s.id).order("created_at", { ascending: false }).limit(50);
    return json({ there: true, distance_m: Math.round(dist), enc: !!s.enc, body: s.body, photo_url: await signedPhoto(db, s.photo), buried_at: s.created_at, maker_name: s.spot_profiles?.name ?? null, maker_photo: s.spot_profiles?.photo ?? null, logbook: finds ?? [], is_maker: isMaker });
  }
  if (a === "reply") {
    const p = await profile(); if (!p) return json({ error: "sign in" }, 401);
    if (!there) return json({ error: "You need to be there" }, 400);
    const note = clean(b.note, 300); if (!note) return json({ error: "missing" }, 400);
    const chk = await textOk(note); if (!chk.ok) return json({ error: "That didn't pass our safety check" }, 422);
    const { data: mineF } = await db.from("spot_finds").select("id").eq("spot_id", s.id).eq("finder_uid", user.id).order("created_at", { ascending: false }).limit(1);
    if ((mineF ?? []).length) await db.from("spot_finds").update({ note, finder_name: p.name }).eq("id", mineF![0].id);
    else await db.from("spot_finds").insert({ spot_id: s.id, finder_uid: user.id, finder_name: p.name, note });
    const { data: finds } = await db.from("spot_finds").select("finder_name, note, created_at").eq("spot_id", s.id).order("created_at", { ascending: false }).limit(50);
    return json({ ok: true, logbook: finds ?? [] });
  }
  return json({ error: "unknown action" }, 400);
});
