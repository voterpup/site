// Tag service: when the keyword rules say "other", a small model confirms the topic or proposes a hashtag.
// Anonymous, cheap (Haiku, ~0.05 cents), capped per day. Proposals are counted so a 14th topic can be born from use.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

async function logFail(svc: string, msg: unknown) {   // founder-alerts mails these
  try { const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); await db.from("svc_errors").insert({ svc, msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* never let logging fail the call */ }
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const TOPICS = ["housing", "homelessness", "transit", "infrastructure", "utilities", "safety", "cost of living", "health", "education", "climate", "cleanliness", "parks", "other"];
const DAILY_CALLS = 4000;
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
const tool = {
  name: "tag", description: "Classify the issue. Call exactly once.", strict: true,
  input_schema: { type: "object", additionalProperties: false, required: ["topic", "hashtag"], properties: {
    topic: { type: "string", enum: TOPICS, description: "The best fit among the fixed topics; 'other' only if none fits" },
    hashtag: { type: "string", description: "One or two lowercase words (no #, no spaces: use underscore) naming what this is really about, e.g. 'wildlife', 'street_vendors', 'noise'. Empty if the topic already says it." } } },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: { text?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const text = String(body.text || "").trim().slice(0, 300);
  if (text.length < 8) return new Response(JSON.stringify({ topic: "other", hashtag: "" }), { headers: CORS });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const day = new Date().toISOString().slice(0, 10);
  const { data: log } = await db.from("svc_log").select("calls").eq("day", day).eq("svc", "tag").maybeSingle();
  if ((log?.calls ?? 0) >= DAILY_CALLS) return new Response(JSON.stringify({ topic: "other", hashtag: "", capped: true }), { headers: CORS });
  await db.from("svc_log").upsert({ day, svc: "tag", calls: (log?.calls ?? 0) + 1 });
  try {
    const res = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 120, tools: [tool], tool_choice: { type: "auto" },
      system: "You classify short complaints residents write about their city, for a neutral community board. Never mention parties, candidates or people. Call the tag tool once.",
      messages: [{ role: "user", content: "Issue: " + text }] });
    const call = res.content.find((b: any) => b.type === "tool_use" && b.name === "tag") as any;
    let topic = TOPICS.includes(call?.input?.topic) ? call.input.topic : "other";
    let hashtag = String(call?.input?.hashtag || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
    if (hashtag.length < 2) hashtag = "";
    if (topic === "other" && hashtag) {
      const { data: p } = await db.from("tag_proposals").select("n").eq("tag", hashtag).maybeSingle();
      await db.from("tag_proposals").upsert({ tag: hashtag, n: (p?.n ?? 0) + 1, sample: text.slice(0, 120), last_seen: new Date().toISOString() });
    }
    return new Response(JSON.stringify({ topic, hashtag }), { headers: { ...CORS, "content-type": "application/json" } });
  } catch (e) {
    await logFail("suggest-tag", e);
    return new Response(JSON.stringify({ topic: "other", hashtag: "", error: String((e as Error).message).slice(0, 100) }), { headers: CORS });
  }
});
