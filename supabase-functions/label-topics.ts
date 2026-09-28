// Supabase Edge Function (deploy later: needs Claude API key as secret + supabase CLI auth)
// Labels untopiced SHARED entries with a civic topic via Claude Haiku. Run on cron (e.g. every 30 min).
// deploy: supabase functions deploy label-topics; secrets: ANTHROPIC_API_KEY, SERVICE_ROLE_KEY
import { createClient } from "npm:@supabase/supabase-js@2";
const TOPICS = ["housing","transit","safety","cost of living","health","climate","cleanliness","parks","other"];
Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SERVICE_ROLE_KEY")!);
  const { data: rows } = await db.from("entries").select("id, body").eq("shared", true).is("topic", null).limit(20);
  if (!rows?.length) return new Response("nothing to label");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 500,
      messages: [{ role: "user", content:
        `Label each civic gripe with ONE topic from: ${TOPICS.join(", ")}. Reply as JSON array of {"id","topic"} only.\n` +
        JSON.stringify(rows) }],
    }),
  });
  const out = await res.json();
  const labels = JSON.parse(out.content[0].text.replace(/```json|```/g, ""));
  for (const l of labels) if (TOPICS.includes(l.topic))
    await db.from("entries").update({ topic: l.topic }).eq("id", l.id);
  return new Response(`labeled ${labels.length}`);
});
