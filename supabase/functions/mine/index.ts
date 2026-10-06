// "Which one's mine?" — a friends game. Actions: prompts (a few to pick from) · create (your answer, hidden among 5 decoys)
// · open (a friend sees the prompt + 6 shuffled cards; the answer never leaves the server) · guess · board (the owner's scoreboard)
// · gen (internal: Claude writes new prompts). Anyone with a pup can make games.
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3";
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
webpush.setVapidDetails("mailto:hi@voterpup.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const ADJ = ["sleepy","muddy","fluffy","waggy","bouncy","sunny","zoomy","snuggly","sniffy","crunchy","jolly","speedy","cozy","sparkly","giggly","happy"];
const NOUN = ["socks","paws","tails","sticks","biscuits","puddles","naps","treats","acorns","bones","frisbees","walks","sniffs","collars"];
const SCORE = [100, 60, 30, 10];
async function logFail(db: any, msg: unknown) { try { await db.from("svc_errors").insert({ svc: "mine", msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* never block */ } }
function shuffle<T>(a: T[]): T[] { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
async function ask(system: string, user: string, max = 1200, model = "claude-sonnet-5-5"): Promise<string> {
  const r = await anthropic.messages.create({ model, max_tokens: max, system, messages: [{ role: "user", content: user }] });
  return (r.content.find((c: any) => c.type === "text") as any)?.text ?? "";
}
const arr = (t: string) => { const m = t.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : []; };
const RULES = "Light, playful, safe for a family WhatsApp group. Never about politics, elections, candidates, parties, religion, race, sex, money worries, health problems, or any real city or place name. No mean jokes about groups of people.";

async function moderate(text: string): Promise<{ ok: boolean; why?: string }> {
  try {
    const t = await ask("You check one short answer in a friends' guessing game. Block ONLY: naming a specific real person, hate or demeaning words about any group, threats, sexual content, phone numbers, addresses, links, ads. Silly, grumpy, weird and honest answers are fine. Reply JSON only: {\"ok\":true} or {\"ok\":false,\"why\":\"<4 words>\"}.", text, 60, "claude-haiku-4-5-20251001");
    const m = t.match(/\{[\s\S]*\}/); const v = m ? JSON.parse(m[0]) : { ok: true }; return { ok: v.ok !== false, why: v.why };
  } catch (e) { return { ok: true }; }
}
// five decoys for a prompt: real answers from other games first, then cached AI ones, topped up by Claude when short
async function decoysFor(db: any, pid: number, ptext: string, mine: string): Promise<string[]> {
  const { data: real } = await db.from("mine_games").select("answer").eq("prompt_id", pid).limit(40);
  const { data: cached } = await db.from("mine_decoys").select("text").eq("prompt_id", pid).limit(60);
  let pool = [...new Set([...(real ?? []).map((r: any) => r.answer), ...(cached ?? []).map((r: any) => r.text)])].filter((t) => t.toLowerCase() !== mine.toLowerCase());
  if (pool.length < 8) {
    try {
      const out = arr(await ask(`You write believable answers that different ordinary people might give to a fill-in prompt in a guessing game. ${RULES} Each answer 2 to 12 words, in a casual phone-typing voice (lowercase is fine, a few typos fine, at most one emoji). Make them varied in personality and length so no single answer stands out. Reply with a JSON array of strings only.`, `Prompt: "${ptext}"\nWrite 12 different answers.`, 700));
      const fresh = out.map((s: any) => String(s).trim().slice(0, 90)).filter((s: string) => s.length >= 2);
      if (fresh.length) await db.from("mine_decoys").upsert(fresh.map((t: string) => ({ prompt_id: pid, text: t })), { onConflict: "prompt_id,text", ignoreDuplicates: true });
      pool = [...new Set([...pool, ...fresh])].filter((t) => t.toLowerCase() !== mine.toLowerCase());
    } catch (e) { await logFail(db, e); }
  }
  return shuffle(pool).slice(0, 5);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let b: any = {}; try { b = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const tail = String(b.tail || "");

  if (b.action === "gen") {   // internal: top the prompt bank up; needs the service key
    if (!Deno.env.get("MINE_ADMIN") || req.headers.get("x-admin") !== Deno.env.get("MINE_ADMIN")) return json({ error: "no" }, 403);
    const kinds = ["wish", "love", "hate", "secret", "guilty pleasure", "would you rather", "tiny joy", "pet peeve", "hot take", "childhood", "if I could", "my superpower", "weird habit", "comfort", "first thing"];
    const kind = b.kind || kinds[Math.floor(Math.random() * kinds.length)];
    const { data: have } = await db.from("mine_prompts").select("text").eq("kind", kind).limit(400);
    const avoid = (have ?? []).slice(-60).map((r: any) => r.text).join(" | ");
    const out = arr(await ask(`You write fill-in-the-blank prompts for a party game: a player completes the sentence about themselves, hides it among strangers' answers, and their friends and family try to guess which answer is theirs. Great prompts are specific, funny, slightly revealing but never embarrassing, and have hundreds of possible answers. ${RULES} Each prompt is one sentence ending in "…" (the player fills it in), 4 to 12 words, in first person.`,
      `Kind: ${kind}.\nWrite 40 new prompts of this kind. Do not repeat or closely copy these: ${avoid}\nReply with a JSON array of strings only.`, 2000));
    const rows = out.map((s: any) => String(s).trim()).filter((s: string) => s.length > 8 && s.length < 90).map((t: string) => ({ text: t.endsWith("…") ? t : t.replace(/[.:]+$/, "") + "…", kind }));
    if (rows.length) await db.from("mine_prompts").upsert(rows, { onConflict: "text", ignoreDuplicates: true });
    const { count } = await db.from("mine_prompts").select("id", { count: "exact", head: true });
    return json({ kind, added: rows.length, total: count });
  }

  if (b.action === "prompts") {   // a handful to choose from (the 🎲 asks again)
    const { count } = await db.from("mine_prompts").select("id", { count: "exact", head: true }).eq("active", true);
    const n = count ?? 0, picks: any[] = [];
    for (let i = 0; i < 6 && n; i++) { const { data } = await db.from("mine_prompts").select("id, text, kind").eq("active", true).range(Math.floor(Math.random() * n), Math.floor(Math.random() * n)).limit(1); if (data?.[0] && !picks.some((p) => p.id === data[0].id)) picks.push(data[0]); }
    return json(picks);
  }

  if (b.action === "open") {   // a friend opens a link: never sends which card is the owner's
    const { data: g } = await db.from("mine_games").select("code, tail, prompt_id, nickname, decoys, expires_at").eq("code", String(b.code || "")).maybeSingle();
    if (!g || new Date(g.expires_at) < new Date()) return json({ error: "This game has ended. Ask for a new link 🐾" }, 404);
    const { data: p } = await db.from("mine_prompts").select("text").eq("id", g.prompt_id).maybeSingle();
    const cards = (g.decoys as any[]).map((d: any) => ({ id: d.id, text: d.text }));
    let play = null;
    if (tail) { const { data } = await db.from("mine_plays").select("wrong, tries, score, done").eq("code", g.code).eq("tail", tail).maybeSingle(); play = data; }
    return json({ prompt: p?.text, nickname: g.nickname, cards, own: tail && tail === g.tail, play });
  }

  if (b.action === "guess") {
    if (!tail) return json({ error: "no pup" }, 400);
    const { data: g } = await db.from("mine_games").select("code, tail, nickname, decoys, answer").eq("code", String(b.code || "")).maybeSingle();
    if (!g) return json({ error: "This game has ended." }, 404);
    if (g.tail === tail) return json({ error: "That's your own! Send it to a friend 🐾" }, 400);
    const right = (g.decoys as any[]).find((d: any) => d.mine)?.id;
    let { data: pl } = await db.from("mine_plays").select("*").eq("code", g.code).eq("tail", tail).maybeSingle();
    if (!pl) { const ins = await db.from("mine_plays").insert({ code: g.code, tail, nickname: String(b.nickname || "").slice(0, 24) || null }).select("*").single(); pl = ins.data; }
    if (pl.done) return json({ done: true, correct: right, score: pl.score, tries: pl.tries, answer: g.answer });
    const pick = String(b.pick || ""), wrong = (pl.wrong as string[]) ?? [];
    if (wrong.includes(pick)) return json({ correct: false, tries: pl.tries, wrong });
    const tries = pl.tries + 1, ok = pick === right, out = !ok && tries >= 4;
    const score = ok ? SCORE[Math.min(tries, 4) - 1] : out ? 0 : null;
    await db.from("mine_plays").update({ tries, wrong: ok ? wrong : [...wrong, pick], done: ok || out, score, nickname: String(b.nickname || pl.nickname || "").slice(0, 24) || null }).eq("code", g.code).eq("tail", tail);
    if (ok || out) {   // tell the owner
      const who = String(b.nickname || pl.nickname || "Someone").slice(0, 24);
      const line = ok ? `${who} found yours on try ${tries} (+${score})` : `${who} couldn't find yours 😎`;
      const { data: subs } = await db.from("push_subs").select("endpoint, p256dh, auth").eq("tail", g.tail);
      for (const s of subs ?? []) webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: "🐾 Which one's mine?", body: line, url: "/m/" + g.code }), { TTL: 6 * 3600 }).catch(() => {});
    }
    return json({ correct: ok, tries, score, done: ok || out, wrong: ok ? wrong : [...wrong, pick], answer: ok || out ? g.answer : undefined, right: ok || out ? right : undefined });
  }

  if (b.action === "random") {   // someone else's live game you haven't played yet
    const { data: mine } = tail ? await db.from("mine_plays").select("code").eq("tail", tail) : { data: [] as any[] };
    const seen = new Set((mine ?? []).map((x: any) => x.code));
    const { data: games } = await db.from("mine_games").select("code, tail").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(200);
    const pool = (games ?? []).filter((g: any) => g.tail !== tail && !seen.has(g.code));
    if (!pool.length) return json({ none: true });
    return json({ code: pool[Math.floor(Math.random() * pool.length)].code });
  }

  if (b.action === "list") {
    if (!tail) return json({ made: [], played: [] });
    const { data: made } = await db.from("mine_games").select("code, answer, prompt_id, created_at, expires_at").eq("tail", tail).order("created_at", { ascending: false }).limit(30);
    const codes = (made ?? []).map((g: any) => g.code);
    const { data: plays } = codes.length ? await db.from("mine_plays").select("code, score, done").in("code", codes) : { data: [] as any[] };
    const { data: mine } = await db.from("mine_plays").select("code, score, tries, done, created_at").eq("tail", tail).order("created_at", { ascending: false }).limit(30);
    const pcodes = (mine ?? []).map((x: any) => x.code);
    const { data: pg } = pcodes.length ? await db.from("mine_games").select("code, nickname, prompt_id").in("code", pcodes) : { data: [] as any[] };
    const pids = [...new Set([...(made ?? []).map((g: any) => g.prompt_id), ...(pg ?? []).map((g: any) => g.prompt_id)])];
    const { data: pr } = pids.length ? await db.from("mine_prompts").select("id, text").in("id", pids) : { data: [] as any[] };
    const ptext = new Map((pr ?? []).map((x: any) => [x.id, x.text]));
    return json({
      made: (made ?? []).map((g: any) => { const ps = (plays ?? []).filter((x: any) => x.code === g.code);
        return { code: g.code, prompt: ptext.get(g.prompt_id), answer: g.answer, players: ps.length, found: ps.filter((x: any) => (x.score ?? 0) > 0).length, live: new Date(g.expires_at) > new Date() }; }),
      played: (mine ?? []).map((x: any) => { const g = (pg ?? []).find((y: any) => y.code === x.code); return { code: x.code, owner: g?.nickname, prompt: g ? ptext.get(g.prompt_id) : null, score: x.score, tries: x.tries, done: x.done }; }),
    });
  }

  if (b.action === "board") {
    const { data: g } = await db.from("mine_games").select("code, tail, answer, nickname, prompt_id").eq("code", String(b.code || "")).maybeSingle();
    if (!g || g.tail !== tail) return json({ error: "not yours" }, 403);
    const { data: p } = await db.from("mine_prompts").select("text").eq("id", g.prompt_id).maybeSingle();
    const { data: plays } = await db.from("mine_plays").select("nickname, tries, score, done, created_at").eq("code", g.code).order("created_at");
    return json({ prompt: p?.text, answer: g.answer, nickname: g.nickname, plays: plays ?? [] });
  }

  // 1) preview: check the question and answer, write decoys, show the mix · 2) roll: new decoys for the same draft · 3) create: send it
  async function tailored(ptext: string, answer: string, avoid: string[]): Promise<string[]> {
    try {
      const out = arr(await ask(`You make decoys for a guessing game. A player answered a prompt; their friends will see the real answer shuffled with your decoys and must spot the real one. Write answers that DIFFERENT people would plausibly give: match the real answer's length (within about 30%), its casualness, capitalisation, punctuation and emoji use, so nothing stands out by style. Vary the content: no paraphrases or near-copies of the real answer, and no answer that is obviously sillier, smarter or more polished than the rest. ${RULES} Reply with a JSON array of 8 strings only.`,
        `Prompt: "${ptext}"\nReal answer: "${answer}"` + (avoid.length ? `\nDo not reuse any of these: ${avoid.join(" | ")}` : ""), 500));
      const L = answer.length, low = avoid.map((x) => x.toLowerCase());
      return out.map((x: any) => String(x).trim().slice(0, 90)).filter((x: string) => x.length >= 2 && x.toLowerCase() !== answer.toLowerCase() && !low.includes(x.toLowerCase()))
        .sort((a: string, c: string) => Math.abs(a.length - L) - Math.abs(c.length - L)).slice(0, 5);
    } catch (e) { await logFail(db, e); return []; }
  }
  const view = (d: any, ptext: string) => ({ draft: d.id, prompt: ptext, cards: (d.decoys as any[]), rolls: d.rolls });

  if (b.action === "preview" || b.action === "roll" || b.action === "create") {
    if (!tail || !(await db.from("ledgers").select("tail").eq("tail", tail).maybeSingle()).data) return json({ error: "no pup" }, 400);
  }

  if (b.action === "preview") {
    const answer = String(b.answer || "").replace(/\s+/g, " ").trim().slice(0, 90), nickname = String(b.nickname || "").trim().slice(0, 24);
    if (answer.length < 2) return json({ error: "Write your answer first." }, 400);
    if (!nickname) return json({ error: "Add the name your friends know you by." }, 400);
    let p: any = null;
    if (b.custom) {   // the player's own question
      let q = String(b.custom).replace(/\s+/g, " ").trim().slice(0, 100);
      if (q.length < 6) return json({ error: "Write a question with a few more words." }, 400);
      const chk = await moderate("Question: " + q);
      if (!chk.ok) return json({ error: "Let's keep the question friendly" + (chk.why ? " (" + chk.why + ")" : "") + " 🐾" }, 422);
      if (!/[…?]$|\.\.\.$/.test(q)) q = q.replace(/[.:]+$/, "") + "…";
      const { data: ex } = await db.from("mine_prompts").select("id, text").eq("text", q).maybeSingle();
      p = ex ?? (await db.from("mine_prompts").insert({ text: q, kind: "your own", active: false, source: "user" }).select("id, text").single()).data;
    } else {
      const { data } = await db.from("mine_prompts").select("id, text").eq("id", Number(b.prompt)).maybeSingle(); p = data;
    }
    if (!p) return json({ error: "Pick a question." }, 400);
    const chk = await moderate(answer);
    if (!chk.ok) return json({ error: "Let's keep it friendly" + (chk.why ? " (" + chk.why + ")" : "") + ". Try another answer 🐾" }, 422);
    let dec = await tailored(p.text, answer, []);
    if (dec.length < 5) dec = [...dec, ...(await decoysFor(db, p.id, p.text, answer)).filter((x) => !dec.includes(x))].slice(0, 5);
    if (dec.length < 3) return json({ error: "Couldn't make the other answers. Try again." }, 500);
    const cards = shuffle([{ id: crypto.randomUUID().slice(0, 8), text: answer, mine: true }, ...dec.map((t) => ({ id: crypto.randomUUID().slice(0, 8), text: t }))]);
    const { data: d, error } = await db.from("mine_drafts").insert({ tail, prompt_id: p.id, answer, nickname, decoys: cards }).select("*").single();
    if (error) return json({ error: error.message }, 500);
    return json(view(d, p.text));
  }

  if (b.action === "roll") {   // fresh decoys; your answer stays
    const { data: d } = await db.from("mine_drafts").select("*").eq("id", String(b.draft || "")).eq("tail", tail).maybeSingle();
    if (!d) return json({ error: "Start again 🐾" }, 404);
    if (d.rolls >= 8) return json({ error: "That's the last roll for this one. Send it or start a new one." }, 429);
    const { data: p } = await db.from("mine_prompts").select("text").eq("id", d.prompt_id).maybeSingle();
    const before = (d.decoys as any[]).filter((c: any) => !c.mine).map((c: any) => c.text);
    const dec = await tailored(p?.text ?? "", d.answer, before);
    if (dec.length < 5) return json({ error: "Couldn't roll new ones. Try again." }, 500);
    const cards = shuffle([{ id: crypto.randomUUID().slice(0, 8), text: d.answer, mine: true }, ...dec.map((t) => ({ id: crypto.randomUUID().slice(0, 8), text: t }))]);
    const { data: d2 } = await db.from("mine_drafts").update({ decoys: cards, rolls: d.rolls + 1 }).eq("id", d.id).select("*").single();
    return json(view(d2, p?.text ?? ""));
  }

  if (b.action === "create") {
    const { count: today } = await db.from("mine_games").select("code", { count: "exact", head: true }).eq("tail", tail).gte("created_at", new Date(Date.now() - 864e5).toISOString());
    if ((today ?? 0) >= 20) return json({ error: "That's a lot of games today. Come back tomorrow 🐾" }, 429);
    const { data: d } = await db.from("mine_drafts").select("*").eq("id", String(b.draft || "")).eq("tail", tail).maybeSingle();
    if (!d) return json({ error: "Start again 🐾" }, 404);
    let code = "";
    for (let i = 0; i < 20; i++) { code = `${2 + Math.floor(Math.random() * 11)}-${ADJ[Math.floor(Math.random() * ADJ.length)]}-${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
      const { data: ex } = await db.from("mine_games").select("code").eq("code", code).maybeSingle(); if (!ex) break; }
    const { error } = await db.from("mine_games").insert({ code, tail, prompt_id: d.prompt_id, answer: d.answer, nickname: d.nickname, decoys: d.decoys });
    if (error) return json({ error: error.message }, 500);
    await db.from("mine_drafts").delete().eq("id", d.id);
    const { data: p } = await db.from("mine_prompts").select("text").eq("id", d.prompt_id).maybeSingle();
    return json({ ok: true, code, prompt: p?.text });
  }
  return json({ error: "bad action" }, 400);
});
