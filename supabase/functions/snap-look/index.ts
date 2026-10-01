// "Walk the pup": one photo of a place -> up to five visible, fixable findings (issue or good thing).
// Haiku 4.5, ~0.4 cents. Safety first in the same call: people-centred or unsafe photos return nothing.
// Nothing is stored here; the client keeps the photo only when the person keeps a finding.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
const MODEL = "claude-haiku-4-5-20251001", PRICE_IN = 1e-6, PRICE_OUT = 5e-6;
const DAILY_CALLS = 800;   // ~$3/day
const TOPICS = ["cleanliness", "infrastructure", "transit", "parks", "safety", "utilities", "housing", "climate", "health", "homelessness", "cost of living", "education"];

const RULES = `You are the eyes of a small dog that walks a city block with its person and notices what the CITY could fix, and what the city got right.
You get one photo of a place. Report only what is clearly VISIBLE in the frame. Up to 5 findings, best first.

Each finding: kind "issue" (something a city or its contractors could fix or improve) or "good" (something the city did well or a public space in good shape); a topic from the list; a line of at most 8 plain words naming the THING ("overflowing bin by the bus stop", "pothole across the lane", "new bike rack, well placed"); confidence 0-1.

Hard rules:
- Describe things, never people. No faces, clothing, bodies, plates, licence numbers, house numbers, shop names, or text that names anyone. Ignore political signs, posters and flags entirely.
- If the photo is mainly of a person, people, a selfie, a pet, an indoor scene, a document, a screen, or food: set safe to "people" (for people/pets/selfies) or "skip" (for the rest) and return no findings.
- If the photo contains nudity, gore, hate symbols, or a child as its subject: safe "block", no findings.
- Prefer the fixable over the aesthetic: "litter around the bins" yes, "ugly building" no. Private property neglect is not a finding unless it affects the public way.
- Say WHAT, not who should: never "the city should". Never guess an address or a place name.
- People in the background of a street scene are fine (just never describe them). Plaques, memorial names, house numbers, shop signs and address numbers are never findings and never quoted.
- Lines: lowercase, at most 8 words, the thing itself. No hedges ("may need", "could be"), no advice, no adjectives like "ugly".
- Unsure about a finding: lower confidence. Nothing visible worth reporting: safe "ok" with an empty list.
Call report exactly once.`;

const tool = { name: "report", description: "The dog's report for this photo.", strict: true, input_schema: { type: "object", properties: {
  safe: { type: "string", enum: ["ok", "people", "skip", "block"] },
  scene: { type: "string", description: "3-6 words: what kind of place this is, no names" },
  findings: { type: "array", items: { type: "object", properties: {
    kind: { type: "string", enum: ["issue", "good"] }, topic: { type: "string", enum: TOPICS }, line: { type: "string" }, confidence: { type: "number" } },
    required: ["kind", "topic", "line", "confidence"], additionalProperties: false } } },
  required: ["safe", "scene", "findings"], additionalProperties: false } };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
  let body: { image?: string; type?: string } = {};
  try { body = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  const type = String(body.type || "image/jpeg");
  if (!/^image\/(jpeg|png|webp)$/.test(type) || !body.image || body.image.length > 2_800_000) return json({ error: "bad image" }, 400);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const day = new Date().toISOString().slice(0, 10);
  const { data: log } = await db.from("svc_log").select("calls").eq("day", day).eq("svc", "snap").maybeSingle();
  if ((log?.calls ?? 0) >= DAILY_CALLS) return json({ safe: "ok", scene: "", findings: [], capped: true });
  await db.from("svc_log").upsert({ day, svc: "snap", calls: (log?.calls ?? 0) + 1 });
  try {
    const res = await anthropic.messages.create({ model: MODEL, max_tokens: 600, system: RULES, tools: [tool], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: type, data: body.image } }, { type: "text", text: "Walk this block. Call report." }] }] } as any);
    const cost = (res.usage?.input_tokens ?? 0) * PRICE_IN + (res.usage?.output_tokens ?? 0) * PRICE_OUT;
    if (res.stop_reason === "refusal") return json({ safe: "block", scene: "", findings: [], cost });
    const call = res.content.find((b: any) => b.type === "tool_use" && b.name === "report") as any;
    if (!call) return json({ safe: "skip", scene: "", findings: [], cost });
    const inp = call.input || {};
    const safe = ["ok", "people", "skip", "block"].includes(inp.safe) ? inp.safe : "skip";
    const findings = safe !== "ok" ? [] : (inp.findings || []).filter((f: any) => f && f.confidence >= 0.5 && TOPICS.includes(f.topic) && /^[\w ,'’.-]{3,60}$/.test(String(f.line)))
      .map((f: any) => ({ kind: f.kind === "good" ? "good" : "issue", topic: f.topic, line: String(f.line).trim().replace(/\.$/, "").split(/\s+/).slice(0, 9).join(" "), confidence: Math.round(f.confidence * 100) / 100 }))
      .filter((f: any) => !/\b(number|plaque|address|sign reads|named)\b/i.test(f.line)).slice(0, 5);
    return json({ safe, scene: String(inp.scene || "").slice(0, 60), findings, cost: Math.round(cost * 1e5) / 1e5 });
  } catch (e) { return json({ error: String((e as Error).message).slice(0, 200) }, 502); }
});
