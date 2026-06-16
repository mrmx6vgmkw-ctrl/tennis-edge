export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Get the full target URL from query string
  const target = req.query.target;

  if (!target) {
    // Debug: return what we actually received
    return res.status(400).json({ 
      error: "No target param", 
      received: JSON.stringify(req.query),
      url: req.url 
    });
  }

  const decoded = decodeURIComponent(target);
  
  if (!decoded.includes("the-odds-api.com")) {
    return res.status(403).json({ error: "Only Odds API requests allowed" });
  }

  try {
    const upstream = await fetch(decoded);
    const data = await upstream.json();
    res.setHeader("x-requests-remaining", upstream.headers.get("x-requests-remaining") || "");
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
