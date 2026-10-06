// Pack chat: read and send messages for members only. Text is checked by Claude Haiku before anyone sees it
// (hate, threats, sexual content, scams); small photos and videos ride along (stored like other media, links signed per read).
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";

async function logFail(svc: string, msg: unknown) {   // founder-alerts mails these
  try { const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); await db.from("svc_errors").insert({ svc, msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* never let logging fail the call */ }
}
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
      system: "You moderate a friendly group chat between friends in a neighbourhood app. Block ONLY: hate or slurs, dehumanising or demeaning words about any group of people (e.g. calling people scum, vermin, animals, or saying a group should be kicked out), threats or incitement to violence, sexual content, harassment aimed at someone, scams or suspicious links, selling drugs or weapons. Swearing in a friendly way, jokes, politics talk, criticism of policies or officials, and local complaints about places, services or behaviour (litter, noise, speeding) are fine. Reply with JSON only: {\"ok\":true} or {\"ok\":false,\"why\":\"<4 words>\"}.",
      messages: [{ role: "user", content: body.slice(0, 500) }] });
    const t = (r.content[0] as any)?.text ?? "";
    const m = t.match(/\{[\s\S]*\}/); const v = m ? JSON.parse(m[0]) : { ok: true };
    return { ok: v.ok !== false, why: v.why };
  } catch (e) { await logFail("pack-chat moderation", e); return { ok: true }; }   // the checker being down never blocks friends; reports still work
}

async function nudge(db: any, pack: string, from: string, line: string, onlyTo?: string) {   // at most once every 30 minutes per member
  const { data: pk } = await db.from("packs").select("name").eq("id", pack).maybeSingle();
  const cut = new Date(Date.now() - 18e5).toISOString();
  let q = db.from("pack_members").select("tail, last_push").eq("pack_id", pack).neq("tail", from);
  q = onlyTo ? q.eq("tail", onlyTo) : q.eq("status", "active");
  const { data: others } = await q;
  for (const o of others ?? []) {
    if (!onlyTo && o.last_push && o.last_push > cut) continue;
    const { data: subs } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("tail", o.tail);
    if (!subs?.length) continue;
    await db.from("pack_members").update({ last_push: new Date().toISOString() }).eq("pack_id", pack).eq("tail", o.tail);
    for (const s of subs) webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({ title: "🐾 " + (pk?.name ?? "Your group"), body: line, url: "/packs/" + pack }), { TTL: 6 * 3600 }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const tail = String(b.tail || ""), pack = String(b.pack || "");
  if (!/^[0-9a-f-]{36}$/.test(pack) || !tail) return json({ error: "bad request" }, 400);
  const { data: mem } = await db.from("pack_members").select("status, role").eq("pack_id", pack).eq("tail", tail).maybeSingle();
  const { data: me } = await db.from("ledgers").select("name").eq("tail", tail).maybeSingle();
  if (b.action === "joined" && mem?.status === "pending") {   // tell the owner someone is waiting at the door
    const { data: pk } = await db.from("packs").select("owner_tail").eq("id", pack).maybeSingle();
    if (pk) await nudge(db, pack, tail, (me?.name ?? "A pup") + " wants to join. Tap to let them in.", pk.owner_tail);
    return json({ ok: true });
  }
  if (!mem || mem.status !== "active") return json({ error: "Not in this group yet." }, 403);

  if (b.action === "read") {
    let q = db.from("pack_messages").select("id, tail, body, media, mod, created_at, item_id").eq("pack_id", pack).order("created_at", { ascending: false }).limit(60);
    if (b.before) q = q.lt("created_at", b.before);
    const { data: rows } = await q;
    const tails = [...new Set((rows ?? []).map((r: any) => r.tail))];
    const { data: names } = tails.length ? await db.from("ledgers").select("tail, name").in("tail", tails) : { data: [] as any[] };
    const nameOf = new Map((names ?? []).map((n: any) => [n.tail, n.name]));
    const paths = new Set<string>(); for (const r of rows ?? []) if (r.mod === "ok") for (const m of r.media ?? []) if (PATH_OK.test(m.path)) paths.add(m.path);
    const signed = new Map<string, string>();
    if (paths.size) { const { data: s } = await db.storage.from("media").createSignedUrls([...paths], 3600); for (const x of s ?? []) if (x.signedUrl && x.path) signed.set(x.path, x.signedUrl); }
    const itemIds = (rows ?? []).map((r: any) => r.item_id).filter(Boolean);
    const topics = new Map<string, any>();
    if (itemIds.length) {
      const { data: its } = await db.from("pack_items").select("id, body, topic, entry_id").in("id", itemIds);
      const { data: vs } = await db.from("pack_votes").select("item_id, tail").in("item_id", itemIds);
      const eids = (its ?? []).map((i: any) => i.entry_id).filter(Boolean);
      const ents = new Map<string, any>();
      if (eids.length) {   // a shared issue shows as an issue tile: its photo (signed link), topic and spot
        const { data: es } = await db.from("entries").select("id, media, topic, spot, lat, lng").in("id", eids);
        const ps: string[] = [];
        for (const e of es ?? []) { const m = (e.media ?? []).find((x: any) => !x.type || String(x.type).startsWith("image")); const pth = m ? (m.path ?? (m.url ? String(m.url).replace(/^.*\/storage\/v1\/object\/(public\/)?media\//, "") : null)) : null;
          e._p = pth && PATH_OK.test(pth) ? pth : null; if (e._p) ps.push(e._p); ents.set(e.id, e); }
        const sg = new Map<string, string>();
        if (ps.length) { const { data: s2 } = await db.storage.from("media").createSignedUrls(ps, 3600); for (const x of s2 ?? []) if (x.signedUrl && x.path) sg.set(x.path, x.signedUrl); }
        for (const e of ents.values()) e._img = e._p ? sg.get(e._p) ?? null : null;
      }
      for (const it of its ?? []) { const e = it.entry_id ? ents.get(it.entry_id) : null;
        topics.set(it.id, { id: it.id, body: it.body, topic: it.topic || e?.topic || null, votes: (vs ?? []).filter((v: any) => v.item_id === it.id).length, voted: (vs ?? []).some((v: any) => v.item_id === it.id && v.tail === tail),
          issue: e ? { img: e._img, spot: e.spot, lat: e.lat, lng: e.lng } : null }); }
    }
    await db.from("pack_members").update({ last_read: new Date().toISOString() }).eq("pack_id", pack).eq("tail", tail);
    return json((rows ?? []).reverse().filter((r: any) => !r.item_id || topics.has(r.item_id)).map((r: any) => ({ id: r.id, mine: r.tail === tail, who: nameOf.get(r.tail) ?? "a pup", ts: r.created_at,
      body: r.mod === "ok" ? r.body : null, hidden: r.mod !== "ok", topic: r.item_id ? topics.get(r.item_id) ?? null : undefined, media: r.mod === "ok" ? (r.media ?? []).map((m: any) => ({ type: m.type, url: signed.get(m.path) })).filter((m: any) => m.url) : [] })));
  }

  if (b.action === "send") {
    const link = String(b.body || "").match(/voterpup\.com\/issue\/([0-9a-f-]{36})/i);
    if (link && !(Array.isArray(b.media) && b.media.length)) { b.action = "add_item"; b.entry = link[1]; b.pasted = true; }
  }
  if (b.action === "send") {
    const body = String(b.body || "").slice(0, 500);
    const media = (Array.isArray(b.media) ? b.media : []).slice(0, 4).filter((m: any) => PATH_OK.test(String(m.path)) && /^(image|video)\/[a-z0-9.+-]+$/.test(String(m.type)))
      .map((m: any) => ({ path: m.path, type: m.type }));
    if (!body.trim() && !media.length) return json({ error: "Say something or add a photo." }, 400);
    const since = new Date(Date.now() - 6e5).toISOString();
    const { count } = await db.from("pack_messages").select("id", { count: "exact", head: true }).eq("tail", tail).gte("created_at", since);
    if ((count ?? 0) >= 40) return json({ error: "Slow down a little 🐾" }, 429);
    const ownGame = /^\s*(https?:\/\/)?(www\.)?voterpup\.com\/m\/[0-9]+-[a-z]+-[a-z]+\s*$/i.test(body);   // our own game link: shown as a game tile
    const chk = ownGame ? { ok: true, why: "" } : await textOk(body);
    if (!chk.ok) return json({ error: "That message wasn't sent" + (chk.why ? " (" + chk.why + ")" : "") + ". Keep it friendly 🐾" }, 422);
    const { data: msg, error } = await db.from("pack_messages").insert({ pack_id: pack, tail, body: body || null, media }).select("id, created_at").single();
    if (error) return json({ error: error.message }, 500);
    await nudge(db, pack, tail, (me?.name ?? "A pup") + ": " + (ownGame ? "🫣 sent a Guess the wish game" : body ? body.slice(0, 80) : "📷 sent a photo"));
    return json({ ok: true, id: msg.id, ts: msg.created_at });
  }
  if (b.action === "add_item") {   // the pack's list can be shared publicly, so items are checked like messages
    let entry: string | null = null, etopic: string | null = null, ebody = "";
    if (/^[0-9a-f-]{36}$/.test(String(b.entry || ""))) {   // sharing one of your own issues into the group
      const { data: e } = await db.from("entries").select("id, tail, body, topic, shared, source").eq("id", b.entry).maybeSingle();
      if (!e || (e.tail !== tail && !e.shared && e.source !== "city311")) return json({ error: "That issue is private." }, 403);
      entry = e.id; etopic = e.topic; ebody = String(e.body || "📷 an issue").slice(0, 140);
      const { data: again } = await db.from("pack_items").select("id").eq("pack_id", pack).eq("entry_id", entry).maybeSingle();
      if (again) return json({ error: "That issue is already in this group. Vote for it there 🐾" }, 409);
    }
    const body = (ebody || String(b.body || "")).replace(/\s+/g, " ").trim().slice(0, 140);
    if (body.length < 2) return json({ error: "Write the issue in a few words." }, 400);
    const { count } = await db.from("pack_items").select("id", { count: "exact", head: true }).eq("pack_id", pack);
    if ((count ?? 0) >= 50) return json({ error: "This list is full (50). Remove a few first." }, 400);
    const { data: dup } = await db.from("pack_items").select("id").eq("pack_id", pack).ilike("body", body).maybeSingle();
    if (dup) return json({ error: "That's already on the list. Vote for it instead 🐾" }, 409);
    const chk = await textOk(body);
    if (!chk.ok) return json({ error: "That wasn't added" + (chk.why ? " (" + chk.why + ")" : "") + ". Keep it friendly 🐾" }, 422);
    const { data: it, error } = await db.from("pack_items").insert({ pack_id: pack, tail, body, topic: etopic || (b.topic ? String(b.topic).slice(0, 30) : null), entry_id: entry }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    await db.from("pack_votes").insert({ item_id: it.id, tail });   // adding it counts as your vote
    await db.from("pack_messages").insert({ pack_id: pack, tail, item_id: it.id });   // and it shows up in the chat as a topic card
    await nudge(db, pack, tail, (entry ? "🐾 " + (me?.name ?? "A pup") + " shared an issue: " : "📌 " + (me?.name ?? "A pup") + " started a topic: ") + body.slice(0, 80) + ". Vote?");
    return json({ ok: true, id: it.id });
  }
  return json({ error: "bad action" }, 400);
});
