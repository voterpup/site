// Renders the owner's weekly report with made-up numbers, from the same template the Monday email uses.
//   node supabase/functions/thatspot/sample_report.ts > "Sample Weekly Report.html"
import { ownerReportHtml, type WeekReport } from "./report_mail.ts";
const r: WeekReport = {
  place: "PoCo Bowl", week_start: "2026-11-02", week_end: "2026-11-08",
  opens_7d: 31, opens_prev: 19, memories_7d: 9, memories_prev: 5, photos_7d: 6, hearts_7d: 44,
  opens_total: 112, memories_total: 27, unique_total: 86, repeat_total: 14,
  top: [
    { body: "Three strikes in a row and the whole lane 6 lost it. Thanks for the birthday song!", has_photo: true, by: "Maya", hearts: 12, created_at: "2026-11-07T20:10:00Z" },
    { body: "Grandpa bowled here in 1962. Tonight he beat me by 40 pins.", has_photo: false, by: "Chris", hearts: 9, created_at: "2026-11-05T19:30:00Z" },
    { body: "Winner of the Saturday league, finally.", has_photo: true, by: "Dev", hearts: 7, created_at: "2026-11-08T01:15:00Z" },
  ],
  wall_url: "https://voterpup.com/myspot/?at=gyqhv23hkr", unsub_url: "https://voterpup.com/myspot/", privacy_url: "https://voterpup.com/privacy.html", sample: true,
};
console.log(ownerReportHtml(r));
