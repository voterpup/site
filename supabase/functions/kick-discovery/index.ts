// Starts the discovery workflow (voterpup/jobs) when a never-checked place is waiting.
// Safe to call anonymously: with nothing pending it does nothing, and GitHub's concurrency
// group collapses repeated dispatches into one pending run.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async () => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { count, error } = await db.from("place_watch").select("place", { count: "exact", head: true })
    .is("last_checked", null);
  if (error) return new Response("db: " + error.message, { status: 500 });
  if (!count) return new Response(JSON.stringify({ dispatched: false, pending: 0 }));
  const token = Deno.env.get("GH_DISPATCH_TOKEN");
  if (!token) return new Response("GH_DISPATCH_TOKEN not set", { status: 500 });
  const r = await fetch("https://api.github.com/repos/voterpup/jobs/actions/workflows/discover.yml/dispatches", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
               "User-Agent": "voterpup-kick", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) return new Response("github " + r.status + ": " + (await r.text()).slice(0, 200), { status: 502 });
  return new Response(JSON.stringify({ dispatched: true, pending: count }));
});
