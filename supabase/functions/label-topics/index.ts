// Labels unlabeled SHARED entries with a civic topic via Claude Haiku.
// Secrets: ANTHROPIC_API_KEY (set in Dashboard -> Edge Functions -> Secrets).
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";

async function logFail(svc: string, msg: unknown) {   // founder-alerts mails these
  try { const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!); await db.from("svc_errors").insert({ svc, msg: String((msg as any)?.message ?? msg).slice(0, 400) }); } catch (_) { /* never let logging fail the call */ }
}

const TOPICS = ["housing","homelessness","transit","infrastructure","utilities","safety","cost of living","health","education","climate","cleanliness","parks","other"];

Deno.serve(async () => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: rows, error } = await db
    .from("entries").select("id, body")
    .eq("shared", true).eq("topic_src", "rule").neq("body", "").limit(20);
  if (error) return new Response("db error: " + error.message, { status: 500 });
  if (!rows?.length) return new Response("nothing to label");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: "Label each civic gripe with exactly ONE topic from this list: " +
          TOPICS.join(", ") +
          ". Tents, encampments or unhoused people are 'homelessness', never 'safety'. Sidewalks, potholes, roads, bridges, railings, streetlights, snow/ice clearing are 'infrastructure'. Water, power, electricity, sewage, drainage, internet outages are 'utilities'. Use 'other' only if nothing fits. Reply with ONLY a JSON array of {\"id\":\"...\",\"topic\":\"...\"} — no prose.\n" +
          JSON.stringify(rows),
      }],
    }),
  });
  if (!res.ok) { const t = await res.text(); await logFail("label-topics", res.status + " " + t); return new Response("anthropic error: " + t, { status: 502 }); }
  const out = await res.json();
  let labels: { id: string; topic: string }[] = [];
  try {
    labels = JSON.parse(out.content[0].text.replace(/```json|```/g, "").trim());
  } catch {
    await logFail("label-topics", "parse error");
    return new Response("parse error", { status: 500 });
  }
  let n = 0;
  for (const l of labels) {
    if (!TOPICS.includes(l.topic)) continue;
    const { error: ue } = await db.from("entries").update({ topic: l.topic, topic_src: "ai" }).eq("id", l.id).neq("topic_src", "user");
    if (!ue) n++;
  }
  return new Response(`labeled ${n}`);
});
