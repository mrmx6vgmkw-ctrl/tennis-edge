// Vercel serverless function — fetches Odds API server-side, no CORS issues
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { target } = req.query;
  if (!target) return res.status(400).json({ error: "target URL required" });

  // Only allow requests to the Odds API
  if (!target.startsWith("https://api.the-odds-api.com/")) {
    return res.status(403).json({ error: "Only Odds API requests allowed" });
  }

  try {
    const upstream = await fetch(decodeURIComponent(target));
    const data = await upstream.json();
    res.setHeader("x-requests-remaining", upstream.headers.get("x-requests-remaining") || "");
    res.setHeader("x-requests-used", upstream.headers.get("x-requests-used") || "");
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
