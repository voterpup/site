// Drafts 2-3 procedural steps per moment. Drafts are stored with how_ok=false and
// never shown until a human approves. The model never writes URLs.
import { createClient } from "npm:@supabase/supabase-js@2";

const RULES = `You write "what you can do" steps for a strictly non-partisan civic app.
Rules:
- 2 or 3 short steps, plain text, one per line, each starting with "• ".
- Procedure ONLY: when, where, how to participate. Never argue for or against anything, never summarize campaigns, never say how to vote.
- Do NOT write any URL or web address. Refer to the provided links by their label only (e.g. "see: Voter guide").
- Eligibility: for kind "election" or "decision", voting requires Canadian citizenship (18+, resident). Add a final step for people who can't vote yet: they can still speak at council public hearings, answer city consultations, and log what matters.
- For kind "voice": anyone who lives there can participate; say how.
- Never invent dates, ID rules, or locations not given to you. If unsure, point to the link label.`;

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: rows, error } = await db.from("elections")
    .select("id, name, kind, level, vote_date, actions").is("how", null).limit(15);
  if (error) return new Response("db error: " + error.message, { status: 500 });
  if (!rows?.length) return new Response(JSON.stringify({ drafted: [] }));
  const drafted: unknown[] = [];
  for (const r of rows) {
    const labels = (r.actions || []).map((a: { label: string }) => a.label);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 300, system: RULES,
        messages: [{ role: "user", content: JSON.stringify({ name: r.name, kind: r.kind, level: r.level, date: r.vote_date, link_labels: labels }) }],
      }),
    });
    if (!res.ok) continue;
    const out = await res.json();
    let how: string = out.content?.[0]?.text?.trim() ?? "";
    if (/https?:\/\/|www\./i.test(how)) continue; // hard guard: reject any URL
    await db.from("elections").update({ how, how_ok: false }).eq("id", r.id);
    drafted.push({ id: r.id, name: r.name, how });
  }
  return new Response(JSON.stringify({ drafted }, null, 1), { headers: { "content-type": "application/json" } });
});
