

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = async (req, res) => {

  const allowedOrigins = new Set([
    "https://iz-tecum.github.io",
    "https://cueconsociety.vercel.app",
    "https://www.cueconsociety.com",
    "https://cueconsociety.com"
  ]);

  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {

    res.setHeader("Access-Control-Allow-Origin", "https://iz-tecum.github.io");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

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
    company = "",
  } = body || {};

  if (String(company).trim().length > 0) {
    return res.status(200).json({ ok: true });
  }

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
