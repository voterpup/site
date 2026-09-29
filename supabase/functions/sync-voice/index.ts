// Blue tier sync: reads PUBLIC Shape Your City project pages, extracts ONLY structured
// "Accepting public comments X -> Y" windows. Never invents deadlines. Honest bot UA,
// ~1 req/sec, new/stale slugs only, loud failure if the list parse looks broken.
import { createClient } from "npm:@supabase/supabase-js@2";

const UA = "VoterPupBot/0.1 (+https://voterpup.com; hi@voterpup.com)";
const BASE = "https://www.shapeyourcity.ca";
const TOPICS = ["housing","transit","safety","cost of living","health","climate","cleanliness","parks","other"];
const MONTHS: Record<string, number> = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,
  august:8,september:9,october:10,november:11,december:12 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decode(s: string) {
  return s.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}
function text(html: string) {
  return decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g," ").replace(/<[^>]+>/g,"\n"))
    .replace(/\n\s*\n+/g,"\n");
}
function parseDate(s: string, yearHint?: number): string | null {
  const m = s.trim().match(/([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()]; if (!mo) return null;
  const y = m[3] ? +m[3] : yearHint; if (!y) return null;
  return `${y}-${String(mo).padStart(2,"0")}-${String(+m[2]).padStart(2,"0")}`;
}
function scopeOf(name: string) {
  return /rezoning|development application|developent application|text amendment|odp amendment|heritage|^\d/i.test(name) ? "site" : "city";
}
function ruleTopic(name: string) {
  const n = name.toLowerCase();
  if (/traffic|bike|pedestrian|street|transit|bus|road|bridge/.test(n)) return "transit";
  if (/park|playground|off-leash|beach|garden/.test(n)) return "parks";
  if (/rezoning|development|housing|residential|rental|text amendment|odp/.test(n)) return "housing";
  return "other";
}

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const listRes = await fetch(BASE + "/projects", { headers: { "User-Agent": UA } });
  if (!listRes.ok) return new Response("list fetch failed: " + listRes.status, { status: 502 });
  const listHtml = await listRes.text();
  const tiles = [...listHtml.matchAll(
    /data-state='published'>[\s\S]*?href="(\/[^"]+)"[\s\S]*?project-tile__meta__name'>([^<]+)</g,
  )].map((m) => ({ slug: m[1], name: decode(m[2]) }));
  if (tiles.length < 20) {
    return new Response(`health check FAILED: parsed ${tiles.length} published tiles — no changes made`, { status: 500 });
  }

  const { data: seen } = await db.from("syc_seen").select("slug")
    .gt("checked_at", new Date(Date.now() - 7 * 86400e3).toISOString());
  const recent = new Set((seen || []).map((r: { slug: string }) => r.slug));
  const todo = tiles.filter((t) => !recent.has(t.slug)).slice(0, 40);
  const today = new Date().toISOString().slice(0, 10);

  const found: { slug: string; name: string; end: string }[] = [];
  for (const t of todo) {
    await sleep(1000);
    let hasWindow = false;
    try {
      const r = await fetch(BASE + t.slug, { headers: { "User-Agent": UA } });
      if (r.ok) {
        const m = text(await r.text()).match(/Accepting public comments\s*\n\s*([^\n]+)/);
        if (m) {
          const parts = m[1].split("→");
          const endRaw = (parts[1] ?? parts[0]).trim();
          const end = parseDate(endRaw);
          if (end && end >= today) { found.push({ ...t, end }); hasWindow = true; }
        }
      }
    } catch (_) { /* skip page, retry next week */ }
    await db.from("syc_seen").upsert({ slug: t.slug, checked_at: new Date().toISOString(), has_window: hasWindow });
  }

  // topics: one cheap batch call for city-scope names; rules for address-level applications
  const topicOf: Record<string, string> = {};
  const cityOnes = found.filter((f) => scopeOf(f.name) === "city");
  if (cityOnes.length && Deno.env.get("ANTHROPIC_API_KEY")) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user",
          content: `Assign ONE topic from [${TOPICS.join(", ")}] to each city consultation. Reply ONLY JSON {"slug":"topic",...}.\n` +
            JSON.stringify(cityOnes.map((f) => ({ slug: f.slug, name: f.name }))) }] }),
      });
      const out = await res.json();
      const parsed = JSON.parse(out.content[0].text.replace(/```json|```/g, "").trim());
      for (const k of Object.keys(parsed)) if (TOPICS.includes(parsed[k])) topicOf[k] = parsed[k];
    } catch (_) { /* fall back to rules */ }
  }

  let upserted = 0;
  for (const f of found) {
    const url = BASE + f.slug;
    const closes = new Date(f.end + "T12:00:00Z").toLocaleDateString("en-CA", { month: "long", day: "numeric" });
    const { error } = await db.from("elections").upsert({
      name: "Have your say: " + f.name, level: "city", region: "vancouver", vote_date: f.end,
      kind: "voice", topic: topicOf[f.slug] ?? ruleTopic(f.name), scope: scopeOf(f.name), source_url: url,
      actions: [{ label: "Read it & comment on Shape Your City", url }],
      how: `• Comments close ${closes}.\n• Read the proposal and send your comment on the project page.\n• Anyone can comment — you don't need to be a citizen or a voter.`,
      how_ok: true,
    }, { onConflict: "source_url" });
    if (!error) upserted++;
  }
  return new Response(JSON.stringify({ tiles: tiles.length, checked: todo.length, open_windows: found.length, upserted }));
});
