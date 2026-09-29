// Reviews images on PUBLICLY VISIBLE entries before they may appear publicly (Pack / candidate view).
// Fail-closed: anything not explicitly 'ok' stays hidden. Videos are held ('hold') - not inspectable here.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
const MAX_IMAGES_PER_RUN = 8;
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

async function review(imageUrl: string): Promise<{ verdict: "ok" | "block"; reason: string }> {
  const res = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
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
  if (res.stop_reason === "refusal") return { verdict: "block", reason: "model declined to review" };
  const call = res.content.find((b: any) => b.type === "tool_use" && b.name === "report_image") as any;
  if (!call) throw new Error("no verdict returned");
  const v = call.input?.verdict;
  if (v !== "ok" && v !== "block") throw new Error("bad verdict");
  return { verdict: v, reason: String(call.input?.reason ?? "").slice(0, 200) };
}

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Public = shared entries, plus every entry of a pup whose owner chose "include my private entries"
  // on their candidate code. Nothing else is ever sent for review.
  const { data: rows, error } = await db.rpc("vp_mod_queue", { p_limit: 200 });
  if (error) return new Response("db: " + error.message, { status: 500 });

  let reviewed = 0, blocked = 0, held = 0, failed = 0;
  for (const row of rows ?? []) {
    if (reviewed >= MAX_IMAGES_PER_RUN) break;
    const media = (row.media ?? []) as any[];
    if (!media.some((m) => !m.mod)) continue;
    let changed = false;
    for (const m of media) {
      if (m.mod) continue;
      // Videos and formats the reviewer can't read (e.g. HEIC) are never shown publicly.
      if (!REVIEWABLE.test(String(m.type))) { m.mod = "hold"; held++; changed = true; continue; }
      if (reviewed >= MAX_IMAGES_PER_RUN) break;
      const { data: s } = await db.storage.from("media").createSignedUrl(m.path, 300);
      if (!s?.signedUrl) { failed++; continue; }
      try {
        const r = await review(s.signedUrl);
        m.mod = r.verdict === "ok" ? "ok" : "blocked";
        m.mod_reason = r.reason;
        if (m.mod === "blocked") blocked++;
        reviewed++; changed = true;
      } catch (e) {
        // stays hidden; retried on the next sweep, parked as "hold" after 3 failures
        m.mod_fail = (m.mod_fail ?? 0) + 1; changed = true; failed++;
        if (m.mod_fail >= 3) { m.mod = "hold"; m.mod_reason = String((e as Error).message ?? e).slice(0, 200); }
      }
    }
    if (changed) await db.from("entries").update({ media }).eq("id", row.id);
  }
  return new Response(JSON.stringify({ reviewed, blocked, held, failed }));
});
