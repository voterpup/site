// Sends a note to the founder's inbox only (hi@voterpup.com). Needs the report key. Recipient is fixed.
Deno.serve(async (req) => {
  let b: { key?: string; subject?: string; text?: string; html?: string } = {};
  try { b = await req.json(); } catch (_) { /* empty */ }
  if (b.key !== Deno.env.get("REPORT_KEY")) return new Response("no", { status: 403 });
  const send = (from: string) => fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({ from, to: ["hi@voterpup.com"], subject: String(b.subject || "VoterPup note").slice(0, 150), text: String(b.text || ""), html: b.html }) });
  let r = await send("VoterPup <pup@voterpup.com>"); if (r.status === 403 || r.status === 422) r = await send("VoterPup <onboarding@resend.dev>");
  return new Response(JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 200) }));
});
