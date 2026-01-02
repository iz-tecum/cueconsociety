// /api/contact.js  (Vercel Serverless Function - CommonJS)

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = async (req, res) => {
  // ✅ CORS (run before any returns)
  const allowedOrigins = new Set([
    "https://iz-tecum.github.io",     // GitHub Pages origin
    "https://cueconsociety.vercel.app" // Stable Vercel domain
  ]);

  const origin = req.headers.origin;

  // Always emit CORS headers (even on errors), so browser doesn't show "Failed to fetch"
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // If origin is missing (server-to-server) or unrecognized, don't reflect it.
    // We still set something so browser gets a readable response.
    res.setHeader("Access-Control-Allow-Origin", "https://iz-tecum.github.io");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "no-store");

  // ✅ Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // If a browser origin is present and not allowed, return 403 *with CORS headers already set*
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed", origin });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "Missing RESEND_API_KEY. Add it in Vercel → Settings → Environment Variables (Production).",
    });
  }

  // Vercel may give req.body as object; sometimes as string
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const {
    name = "",
    email = "",
    subject = "",
    message = "",
    company = "", // honeypot
  } = body || {};

  // Honeypot: if bots fill it, silently succeed
  if (String(company).trim().length > 0) {
    return res.status(200).json({ ok: true });
  }

  // Basic validation
  if (
    !String(name).trim() ||
    !String(email).trim() ||
    !String(subject).trim() ||
    !String(message).trim()
  ) {
    return res
      .status(400)
      .json({ error: "Please fill out name, email, subject, and message." });
  }
  if (!String(email).includes("@")) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const to = process.env.CONTACT_TO || "ilt2109@columbia.edu";
  const from = process.env.CONTACT_FROM || "onboarding@resend.dev";

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replaceAll("\n", "<br/>");

  const payload = {
    from,
    to: [to],
    reply_to: email,
    subject: `CES Contact: ${subject}`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>New CES Contact Form Message</h2>
        <p><b>Name:</b> ${safeName}</p>
        <p><b>Email:</b> ${safeEmail}</p>
        <p><b>Subject:</b> ${safeSubject}</p>
        <hr/>
        <p>${safeMessage}</p>
      </div>
    `,
  };

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({
        error: data?.message || data?.error || "Resend rejected the request",
        details: data,
      });
    }

    return res.status(200).json({ ok: true, id: data?.id });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};
