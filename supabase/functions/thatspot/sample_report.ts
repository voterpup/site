// Renders the owner's weekly report with made-up numbers, from the same template the Monday email uses.
//   node supabase/functions/thatspot/sample_report.ts > thatspot/demo/report.html            # the example shop, linked from the owner demo
//   node supabase/functions/thatspot/sample_report.ts "PoCo Bowl" https://voterpup.com/myspot/?at=gyqhv23hkr > "Sample Weekly Report.html"
import { ownerReportHtml, type WeekReport } from "./report_mail.ts";
const place = process.argv[2] || "PoCo Bowl", wall_url = process.argv[3] || "https://voterpup.com/myspot/?demo=owner";
const r: WeekReport = {
  place, week_start: "2026-11-02", week_end: "2026-11-08",
  opens_7d: 31, opens_prev: 19, memories_7d: 9, memories_prev: 5, photos_7d: 6, hearts_7d: 44,
  opens_total: 112, memories_total: 27, unique_total: 86, repeat_total: 14,
  top: [
    { body: "Strike on the very last frame. Nobody saw it, so here is the proof.", has_photo: true, by: "Denise", hearts: 23, created_at: "2026-11-07T20:10:00Z" },
    { body: "Date night. She picked the pink ball and still won.", has_photo: false, by: "Sam", hearts: 19, created_at: "2026-11-05T19:30:00Z" },
    { body: "Three generations on one lane tonight.", has_photo: false, by: "Linda", hearts: 14, created_at: "2026-11-08T01:15:00Z" },
  ],
  wall_url, unsub_url: "https://voterpup.com/myspot/", privacy_url: "https://voterpup.com/myspot/privacy.html", sample: true,
};
console.log(ownerReportHtml(r));
