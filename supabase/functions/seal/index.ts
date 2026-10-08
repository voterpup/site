// Sealed drops: a call sealed between two people until a date. Texts stay hidden from the other person until opens_at.
// POST {action, ...}: create | get | counter | mark | email | mine | cron. Cron every 10 min mails both sides when a seal opens.
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://voterpup.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const dev = (s: unknown) => clean(s, 40).replace(/[^a-z0-9]/gi, "");
const code = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; const b = crypto.getRandomValues(new Uint8Array(10)); return Array.from(b, (x) => a[x % a.length]).join(""); };
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

async function mail(to: string, subject: string, body: string, cta: string, url: string) {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key) throw new Error("no RESEND_API_KEY");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#1d2433"><p style="font-size:22px;margin:0 0 6px">🐾 VoterPup</p><p style="font-size:16px;line-height:1.5">${esc(body)}</p><p><a href="${url}" style="display:inline-block;background:#e8b84b;color:#2a2418;font-weight:800;padding:12px 18px;border-radius:999px;text-decoration:none">${esc(cta)}</a></p><p style="font-size:12px;color:#6b7387;margin-top:28px">You asked to be told when this seal opens. One email per seal, nothing else. VoterPup · <a href="${SITE}/privacy.html" style="color:#6b7387">Privacy</a></p></div>`;
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ from: "VoterPup <pup@voterpup.com>", to: [to], subject, html, text: `${body}\n\n${cta}: ${url}` }) });
  if (!r.ok) throw new Error("resend " + r.status + " " + (await r.text()).slice(0, 160));
}

// what each role may see: your own text always, the other side's only once open
function view(s: any, d: string) {
  const open = new Date(s.opens_at).getTime() <= Date.now();
  const role = s.creator_dev === d ? "creator" : s.counter_dev && s.counter_dev === d ? "friend" : "viewer";
  const both = !!(s.creator_mark && s.friend_mark);
  return {
    code: s.code, role, open, opens_at: s.opens_at, created_at: s.created_at,
    creator_name: s.creator_name, friend_name: s.friend_name, counter_name: s.counter_name, has_counter: !!s.counter_text,
    call_text: open || role === "creator" ? s.call_text : null,
    counter_text: open || role === "friend" ? s.counter_text : null,
    my_mark: role === "creator" ? s.creator_mark : role === "friend" ? s.friend_mark : null,
    marks: open ? { creator: s.creator_mark, friend: s.friend_mark, agreed: both && s.creator_mark === s.friend_mark ? s.creator_mark : null } : null,
    has_email: role === "creator" ? !!s.creator_email : role === "friend" ? !!s.friend_email : false,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const a = b.action, d = dev(b.dev);

  if (a === "cron") {
    const { data: due } = await db.from("seals").select("*").is("notified_at", null).lte("opens_at", new Date().toISOString()).limit(50);
    let sent = 0, failed = 0;
    for (const s of due ?? []) {
      const url = `${SITE}/seal/?s=${s.code}`;
      const tries: [string | null, string][] = [[s.creator_email, s.friend_name], [s.friend_email, s.creator_name]];
      for (const [to, other] of tries) {
        if (!to) continue;
        try { await mail(to, `🔓 Your seal with ${other} just opened`, `The day came. Your call and ${other}'s are both unsealed now. Go see who called it.`, "Open the seal", url); sent++; }
        catch (e) { failed++; console.error(s.code, String(e)); }
      }
      await db.from("seals").update({ notified_at: new Date().toISOString() }).eq("id", s.id);
    }
    return json({ due: (due ?? []).length, sent, failed });
  }

  if (a === "create") {
    const text = clean(b.text, 280), name = clean(b.name, 40) || "Someone", to = clean(b.to, 40) || "a friend";
    const opens = new Date(b.opens_at); if (!text || isNaN(opens.getTime())) return json({ error: "missing" }, 400);
    if (opens.getTime() < Date.now() + 60 * 60 * 1000) return json({ error: "too soon" }, 400);
    if (opens.getTime() > Date.now() + 5 * 366 * 86400 * 1000) return json({ error: "too far" }, 400);
    const c = code();
    const { error } = await db.from("seals").insert({ code: c, creator_dev: d || "anon", creator_name: name, friend_name: to, call_text: text, opens_at: opens.toISOString(), src: clean(b.src, 24) || null });
    if (error) return json({ error: "db" }, 500);
    return json({ code: c });
  }

  const c = clean(b.code, 12).replace(/[^a-z0-9]/g, "");
  const { data: s } = c ? await db.from("seals").select("*").eq("code", c).maybeSingle() : { data: null };
  if (a === "mine") {
    if (!d) return json({ seals: [] });
    const { data } = await db.from("seals").select("*").or(`creator_dev.eq.${d},counter_dev.eq.${d}`).order("opens_at", { ascending: true }).limit(60);
    return json({ seals: (data ?? []).map((x) => view(x, d)) });
  }
  if (!s) return json({ error: "not found" }, 404);
  const open = new Date(s.opens_at).getTime() <= Date.now();

  if (a === "get") { await db.from("seals").update({ views: (s.views ?? 0) + 1 }).eq("id", s.id); return json(view(s, d)); }
  if (a === "counter") {
    if (open) return json({ error: "already open" }, 400);
    if (s.counter_text) return json({ error: "already countered" }, 400);
    if (d && d === s.creator_dev) return json({ error: "own seal" }, 400);
    const text = clean(b.text, 280), name = clean(b.name, 40) || s.friend_name; if (!text) return json({ error: "missing" }, 400);
    await db.from("seals").update({ counter_text: text, counter_name: name, counter_dev: d || "anon", counter_at: new Date().toISOString() }).eq("id", s.id);
    const { data: s2 } = await db.from("seals").select("*").eq("id", s.id).single(); return json(view(s2, d));
  }
  if (a === "mark") {
    if (!open) return json({ error: "sealed" }, 400);
    const m = clean(b.mark, 10); if (!["creator", "friend", "both", "neither"].includes(m)) return json({ error: "bad mark" }, 400);
    const col = d === s.creator_dev ? "creator_mark" : d === s.counter_dev ? "friend_mark" : null; if (!col) return json({ error: "not yours" }, 403);
    await db.from("seals").update({ [col]: m }).eq("id", s.id);
    const { data: s2 } = await db.from("seals").select("*").eq("id", s.id).single(); return json(view(s2, d));
  }
  if (a === "email") {
    const em = clean(b.email, 120).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: "bad email" }, 400);
    const col = d === s.creator_dev ? "creator_email" : d === s.counter_dev ? "friend_email" : null; if (!col) return json({ error: "not yours" }, 403);
    await db.from("seals").update({ [col]: em }).eq("id", s.id); return json({ ok: true });
  }
  return json({ error: "unknown action" }, 400);
});
