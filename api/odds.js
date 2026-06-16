// Vercel serverless function — runs on the server, no CORS issues
// Proxies requests to The Odds API
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: "path required" });

  const qs = new URLSearchParams(params).toString();
  const url = `https://api.the-odds-api.com/v4/${path}${qs ? "?" + qs : ""}`;

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    
    // Forward quota headers to client
    res.setHeader("x-requests-remaining", upstream.headers.get("x-requests-remaining") || "");
    res.setHeader("x-requests-used", upstream.headers.get("x-requests-used") || "");
    
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
