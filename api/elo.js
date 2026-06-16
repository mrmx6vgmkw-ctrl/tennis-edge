// Vercel serverless function — scrapes live Elo ratings from Tennis Abstract
// tennisabstract.com/reports/atp_elo_ratings.html (updated daily by Jeff Sackmann)
// Vercel edge cache: 1 hour

export const config = { maxDuration: 30 };

async function scrapeEloPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tennis-edge-app/1.0)" }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();

  const players = {};

  // Parse table rows — Tennis Abstract uses a standard HTML table
  // Each row: Rank | Player | Overall Elo | Hard Elo | Clay Elo | Grass Elo | ...
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const tagRegex = /<[^>]+>/g;

  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    const cells = [];
    let m;
    const cellMatcher = new RegExp(cellRegex.source, 'gi');
    while ((m = cellMatcher.exec(row)) !== null) {
      cells.push(m[1].replace(tagRegex, "").trim());
    }

    // Expect at least 6 columns: rank, name, overall, hard, clay, grass
    if (cells.length < 6) continue;

    const name = cells[1]?.trim();
    const overall = parseFloat(cells[2]);
    const hard    = parseFloat(cells[3]);
    const clay    = parseFloat(cells[4]);
    const grass   = parseFloat(cells[5]);

    if (!name || isNaN(overall)) continue;
    if (name.toLowerCase().includes("player") || name.toLowerCase().includes("rank")) continue;

    players[name] = {
      overall: Math.round(overall),
      Hard:    Math.round(isNaN(hard)  ? overall : hard),
      Clay:    Math.round(isNaN(clay)  ? overall : clay),
      Grass:   Math.round(isNaN(grass) ? overall : grass),
    };
  }

  return players;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const [atpPlayers, wtaPlayers] = await Promise.all([
      scrapeEloPage("https://tennisabstract.com/reports/atp_elo_ratings.html"),
      scrapeEloPage("https://tennisabstract.com/reports/wta_elo_ratings.html"),
    ]);

    const ratings = { ...atpPlayers, ...wtaPlayers };
    const count = Object.keys(ratings).length;

    // Cache for 1 hour on Vercel edge
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");

    return res.status(200).json({
      players: count,
      source: "tennisabstract.com (Jeff Sackmann)",
      ratings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
