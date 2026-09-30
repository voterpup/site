// Reviews images on PUBLICLY VISIBLE entries before they may appear publicly (Pack / candidate view).
// Fail-closed: anything not explicitly 'ok' stays hidden. Videos are held ('hold') - not inspectable here.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
const MAX_IMAGES_PER_RUN = 8;
const DAILY_BUDGET_USD = 2;   // past it, photos simply stay "under review" until tomorrow (Haiku: ~1,000 photos)
// Haiku 4.5: $1 / $5 per million input / output tokens. A 768px image is ~800 tokens: ~0.1-0.2 cents per photo.
const MODEL = "claude-haiku-4-5-20251001";
const PRICE_IN = 1e-6, PRICE_OUT = 5e-6;
const REVIEWABLE = /^image\/(jpeg|png|gif|webp)$/;

const RULES = `You review photos that people attach to civic complaints ("this should be fixed") before they appear on a public community board.
Block the image if it contains ANY of: nudity or sexual content; graphic violence, gore, or self-harm; hate symbols or hateful text; a readable personal document (ID card, mail or bill with a name/address, medical record); a child as the clear subject of the photo.
Ordinary street scenes are fine, including people in the background, litter, damage, traffic, buildings, crowds.
Call the report_image tool exactly once with your verdict.`;

const reportTool = {
  name: "report_image",
  description: "Report the moderation verdict for the image.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["ok", "block"] },
      reason: { type: "string" },
    },
    required: ["verdict", "reason"],
    additionalProperties: false,
  },
};

async function review(imageUrl: string): Promise<{ verdict: "ok" | "block"; reason: string; cost: number }> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: RULES,
    tools: [reportTool],
    tool_choice: { type: "auto" },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: imageUrl } },
        { type: "text", text: "Review this image and call report_image." },
      ],
    }],
  } as any);
  const cost = (res.usage?.input_tokens ?? 0) * PRICE_IN + (res.usage?.output_tokens ?? 0) * PRICE_OUT;
  if (res.stop_reason === "refusal") return { verdict: "block", reason: "model declined to review", cost };
  const call = res.content.find((b: any) => b.type === "tool_use" && b.name === "report_image") as any;
  if (!call) throw new Error("no verdict returned");
  const v = call.input?.verdict;
  if (v !== "ok" && v !== "block") throw new Error("bad verdict");
  return { verdict: v, reason: String(call.input?.reason ?? "").slice(0, 200), cost };
}

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Public = shared entries, plus every entry of a pup whose owner chose "include my private entries"
  // on their candidate code. Nothing else is ever sent for review.
  const { data: rows, error } = await db.rpc("vp_mod_queue", { p_limit: 200 });
  if (error) return new Response("db: " + error.message, { status: 500 });

  const day = new Date().toISOString().slice(0, 10);
  const { data: log } = await db.from("mod_log").select("reviews, cost_usd").eq("day", day).maybeSingle();
  const doneToday = log?.reviews ?? 0;
  let spent = Number(log?.cost_usd ?? 0);
  const over = () => spent >= DAILY_BUDGET_USD;

  let reviewed = 0, blocked = 0, held = 0, failed = 0, abort = "";
  for (const row of rows ?? []) {
    if (reviewed >= MAX_IMAGES_PER_RUN || over() || abort) break;
    const media = (row.media ?? []) as any[];
    if (!media.some((m) => !m.mod)) continue;
    let changed = false;
    for (const m of media) {
      if (m.mod) continue;
      // Videos and formats the reviewer can't read (e.g. HEIC) are never shown publicly.
      if (!REVIEWABLE.test(String(m.type))) { m.mod = "hold"; held++; changed = true; continue; }
      if (reviewed >= MAX_IMAGES_PER_RUN || over() || abort) break;
      // a 768px copy is plenty to judge a photo and costs ~4x fewer tokens (falls back to the original)
      let { data: s } = await db.storage.from("media").createSignedUrl(m.path, 300, { transform: { width: 768, height: 768, resize: "contain" } });
      if (!s?.signedUrl) ({ data: s } = await db.storage.from("media").createSignedUrl(m.path, 300));
      if (!s?.signedUrl) { failed++; continue; }
      try {
        const r = await review(s.signedUrl);
        spent += r.cost;
        m.mod = r.verdict === "ok" ? "ok" : "blocked";
        m.mod_reason = r.reason;
        if (m.mod === "blocked") blocked++;
        reviewed++; changed = true;
      } catch (e: any) {
        failed++;
        const msg = String(e?.message ?? e);
        // Only an error about THIS image counts against it; anything else (auth, rate limit, outage,
        // a bad request shape) stops the run and leaves every image untouched for the next sweep.
        if (e?.status === 400 && /image|media|download|fetch|url/i.test(msg)) {
          m.mod_fail = (m.mod_fail ?? 0) + 1; changed = true;
          if (m.mod_fail >= 3) { m.mod = "hold"; m.mod_reason = msg.slice(0, 200); }
        } else { abort = msg.slice(0, 300); }
      }
    }
    if (changed) await db.from("entries").update({ media }).eq("id", row.id);
  }
  if (reviewed) await db.from("mod_log").upsert({ day, reviews: doneToday + reviewed, cost_usd: spent.toFixed(4) });
  return new Response(JSON.stringify({ reviewed, blocked, held, failed, abort: abort || undefined, doneToday: doneToday + reviewed,
                                       spentToday: Number(spent.toFixed(4)), budget: DAILY_BUDGET_USD }),
                      { status: abort ? 502 : 200 });
});
