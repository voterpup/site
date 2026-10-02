// Link preview for one shared issue: Open Graph tags for WhatsApp/iMessage/Slack, then the person is sent on to the Pack.
import { createClient } from "npm:@supabase/supabase-js@2";
const SITE = "https://voterpup.com", SB = Deno.env.get("SUPABASE_URL")!;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
Deno.serve(async (req) => {
  const url = new URL(req.url); const id = (url.searchParams.get("e") || url.pathname.split("/").pop() || "").replace(/[^0-9a-f-]/g, "");
  const db = createClient(SB, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: e } = id.length === 36 ? await db.rpc("vp_share_info", { p_id: id }) : { data: null };
  const title = e ? `“${e.body}”` : "VoterPup";
  const desc = e ? [e.backs ? `${e.backs} ${e.backs === 1 ? "person agrees" : "people agree"}` : "Same here?", e.topic && e.topic !== "other" ? "#" + e.topic : null, e.place || null].filter(Boolean).join(" · ") + " · A pup that remembers what you want fixed."
                 : "A pup that remembers what you want fixed.";
  const card = e ? `${SB}/storage/v1/object/public/cards/${e.id}.png` : `${SITE}/pup-share.jpg`;
  const to = e ? `${SITE}/pack?q=${encodeURIComponent(String(e.body).slice(0, 40))}` : SITE;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · VoterPup</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="VoterPup"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${card}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(url.href)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${card}">
<meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0;url=${esc(to)}"><script>location.replace(${JSON.stringify(to)})</script>
<style>body{font-family:system-ui;padding:40px;text-align:center;color:#1d2433}</style></head><body><p>${esc(title)}</p><p><a href="${esc(to)}">Open on VoterPup →</a></p></body></html>`;
  const h = new Headers(); h.set("Content-Type", "text/html; charset=utf-8"); h.set("Cache-Control", "public, max-age=300");
  return new Response(html, { status: 200, headers: h });
});
