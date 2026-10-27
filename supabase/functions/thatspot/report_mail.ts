// The shop owner's weekly report, as an email. Pure template: no Deno, no database, so the same file renders the sample
// report locally (node --experimental-strip-types) and the real one from the edge function every Monday.
export type WeekMemory = { body: string | null; has_photo: boolean; by: string | null; hearts: number; created_at: string };
export type WeekReport = {
  place: string; week_start: string; week_end: string;   // ISO dates, the Monday-to-Sunday just finished
  opens_7d: number; opens_prev: number;                  // people who opened the wall this week and the week before
  memories_7d: number; memories_prev: number;            // memories left this week and the week before
  photos_7d: number; hearts_7d: number;
  opens_total: number; memories_total: number; unique_total: number; repeat_total: number;
  top: WeekMemory[];                                     // up to 3 memories of the week, most hearts first
  wall_url: string; unsub_url: string; privacy_url: string;
  sample?: boolean;                                      // a banner says this is sample data
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const day = (iso: string) => new Date(iso + (iso.length === 10 ? "T12:00:00Z" : "")).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
function delta(now: number, prev: number) {   // "+3 vs last week", "same as last week", "first week"
  if (!prev && !now) return "nothing yet";
  if (!prev) return "first week with activity";
  const d = now - prev; return d === 0 ? "same as last week" : (d > 0 ? "+" : "−") + Math.abs(d) + " vs last week";
}
function tile(n: number, label: string, sub: string) {
  return `<td style="width:50%;padding:6px"><div style="background:#fffdf7;border:1px solid #efe6cf;border-radius:14px;padding:14px 14px 12px"><div style="font:700 34px/1 Georgia,serif;color:#1d2433">${n}</div><div style="font:700 13px system-ui,sans-serif;color:#1d2433;margin-top:6px">${esc(label)}</div><div style="font:500 12px system-ui,sans-serif;color:#6b7387;margin-top:2px">${esc(sub)}</div></div></td>`;
}
function memoryRow(m: WeekMemory) {
  const text = m.body ? m.body.slice(0, 120) + (m.body.length > 120 ? "…" : "") : "A photo";
  return `<div style="background:#fff;border:1px solid #efe6cf;border-radius:14px;padding:12px 14px;margin:0 0 8px"><div style="font:600 16px/1.35 Georgia,serif;color:#1d2433">${m.has_photo ? "📷 " : ""}${esc(text)}</div><div style="font:600 12px system-ui,sans-serif;color:#6b7387;margin-top:6px">${esc(m.by || "Someone")} · ${day(m.created_at)}${m.hearts ? " · ♥ " + m.hearts : ""}</div></div>`;
}
export function ownerReportHtml(r: WeekReport) {
  const range = `${day(r.week_start)} – ${day(r.week_end)}`;
  const quiet = !r.opens_7d && !r.memories_7d;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(r.place)}: your week on the memory wall</title></head>
<body style="margin:0;background:#f3eee2;padding:20px 12px"><div style="max-width:520px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433">
${r.sample ? `<div style="background:#1d2433;color:#ffcd5e;border-radius:12px;padding:10px 14px;font:800 13px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;text-align:center;margin:0 0 12px">Sample report · the numbers are made up</div>` : ""}
<div style="background:#fff;border:1px solid #efe6cf;border-radius:22px;padding:22px 20px 18px">
  <div style="font:800 12px system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#a8740a">📍 Memory wall · weekly report</div>
  <h1 style="font:700 28px/1.15 Georgia,serif;margin:8px 0 2px">${esc(r.place)}</h1>
  <div style="font:600 14px system-ui,sans-serif;color:#6b7387">${range}</div>
  <p style="font:500 16px/1.5 system-ui,sans-serif;margin:16px 0 4px">${quiet ? "A quiet week at the wall. The card at the counter does the work; a word from staff (“leave one on our wall”) doubles it." : `${r.opens_7d} ${r.opens_7d === 1 ? "person" : "people"} opened the wall this week, and ${r.memories_7d} ${r.memories_7d === 1 ? "memory was" : "memories were"} left.`}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;margin:10px -6px 0;width:calc(100% + 12px)"><tr>
    ${tile(r.opens_7d, "opened the wall", delta(r.opens_7d, r.opens_prev))}${tile(r.memories_7d, "memories left", delta(r.memories_7d, r.memories_prev))}</tr><tr>
    ${tile(r.photos_7d, "photos", "this week")}${tile(r.hearts_7d, "hearts given", "this week")}</tr></table>
  ${r.top.length ? `<div style="font:800 12px system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#a8740a;margin:18px 0 8px">Memories of the week</div>${r.top.map(memoryRow).join("")}` : ""}
  <div style="font:800 12px system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#a8740a;margin:18px 0 8px">Since the start</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font:600 14px system-ui,sans-serif;color:#1d2433">
    <tr><td style="padding:6px 0;border-bottom:1px solid #efe6cf">Memories on the wall</td><td style="padding:6px 0;border-bottom:1px solid #efe6cf;text-align:right;font-weight:800">${r.memories_total}</td></tr>
    <tr><td style="padding:6px 0;border-bottom:1px solid #efe6cf">Times the wall was opened</td><td style="padding:6px 0;border-bottom:1px solid #efe6cf;text-align:right;font-weight:800">${r.opens_total}</td></tr>
    <tr><td style="padding:6px 0;border-bottom:1px solid #efe6cf">Different visitors</td><td style="padding:6px 0;border-bottom:1px solid #efe6cf;text-align:right;font-weight:800">${r.unique_total}</td></tr>
    <tr><td style="padding:6px 0">Came back more than once</td><td style="padding:6px 0;text-align:right;font-weight:800">${r.repeat_total}</td></tr></table>
  <p style="margin:20px 0 4px"><a href="${esc(r.wall_url)}" style="display:inline-block;background:#f5b83d;color:#1a1304;font:800 15px system-ui,sans-serif;padding:13px 20px;border-radius:999px;text-decoration:none">Open your wall &amp; owner panel</a></p>
  <p style="font:500 13px/1.5 system-ui,sans-serif;color:#6b7387;margin:10px 0 0">Visitors are counted, never identified: we don't store where anyone stood, and there are no ads on the map.</p>
</div>
<p style="font:500 12px/1.5 system-ui,sans-serif;color:#6b7387;text-align:center;margin:16px 0 0">You get this every Monday because your shop is on the memory wall at voterpup.com/myspot.<br><a href="${esc(r.unsub_url)}" style="color:#6b7387">Unsubscribe</a> · <a href="${esc(r.privacy_url)}" style="color:#6b7387">Privacy</a> · hi@voterpup.com</p>
</div></body></html>`;
}
export function ownerReportText(r: WeekReport) {
  return `${r.place}: your week on the memory wall (${day(r.week_start)} – ${day(r.week_end)})\n\nThis week: ${r.opens_7d} opened the wall (${delta(r.opens_7d, r.opens_prev)}), ${r.memories_7d} memories left (${delta(r.memories_7d, r.memories_prev)}), ${r.photos_7d} photos, ${r.hearts_7d} hearts.\nSince the start: ${r.memories_total} memories, ${r.opens_total} opens, ${r.unique_total} different visitors, ${r.repeat_total} came back more than once.\n\nOpen your wall: ${r.wall_url}\nUnsubscribe: ${r.unsub_url}`;
}
