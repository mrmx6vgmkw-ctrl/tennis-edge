// Vercel serverless function — computes real Elo ratings from Jeff Sackmann's data
// Sources: github.com/JeffSackmann/tennis_atp + tennis_wta (CC BY-NC-SA 4.0)
// Fetches last 3 years of matches, computes surface-specific Elo for every player

const ATP_BASE = "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master";
const WTA_BASE = "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master";

// Surface Elo K-factor — how fast ratings move per surface
const K = 32;
const DEFAULT_ELO = 1500;

function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || "").trim().replace(/"/g, ""));
    return obj;
  });
}

function surfaceFromCode(s) {
  if (!s) return "Hard";
  s = s.toLowerCase();
  if (s.includes("clay")) return "Clay";
  if (s.includes("grass")) return "Grass";
  return "Hard";
}

async function fetchMatches(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const text = await r.text();
    return parseCSV(text);
  } catch { return []; }
}

async function buildEloRatings(tour) {
  const base = tour === "atp" ? ATP_BASE : WTA_BASE;
  const prefix = tour === "atp" ? "atp" : "wta";
  const years = [2022, 2023, 2024, 2025, 2026];

  const ratings = {};

  function getElo(name) {
    if (!ratings[name]) ratings[name] = { overall: DEFAULT_ELO, Hard: DEFAULT_ELO, Clay: DEFAULT_ELO, Grass: DEFAULT_ELO, matches: 0 };
    return ratings[name];
  }

  function updateElo(winner, loser, surface, kFactor) {
    const w = getElo(winner);
    const l = getElo(loser);
    const k = kFactor || K;
    const expW = expectedScore(w.overall, l.overall);
    w.overall += k * (1 - expW);
    l.overall += k * (0 - (1 - expW));
    const surf = surface || "Hard";
    const expWS = expectedScore(w[surf], l[surf]);
    w[surf] += k * (1 - expWS);
    l[surf] += k * (0 - (1 - expWS));
    w.matches++;
    l.matches++;
  }

  // File types to fetch per year
  const fileTypes = [
    // Tour-level (most reliable signal, full K)
    { suffix: "", k: 32 },
    // Challenger + ITF qualifying (good signal, slightly lower K)
    { suffix: "_qual_chall", k: 24 },
    // ITF futures (weaker signal, lower K so it doesn't swamp tour results)
    { suffix: "_itf", k: 16 },
  ];

  for (const year of years) {
    for (const { suffix, k } of fileTypes) {
      const url = `${base}/${prefix}_matches${suffix}_${year}.csv`;
      const matches = await fetchMatches(url);
      for (const m of matches) {
        const winner = m.winner_name;
        const loser = m.loser_name;
        const surface = surfaceFromCode(m.surface);
        if (winner && loser) updateElo(winner, loser, surface, k);
      }
    }
  }

  return ratings;
}

// Normalize player name from Odds API format to Sackmann format
// Odds API: "A. de Minaur" → Sackmann: "Alex De Minaur"
// We try both directions
function normalizeName(raw) {
  if (!raw) return "";
  // Already in "First Last" format
  if (raw.includes(" ") && !raw.match(/^[A-Z]\./)) return raw;
  // "A. Last" format — can't reliably expand, return as-is for fuzzy match
  return raw;
}

// Find best matching player name in our ratings
function findPlayer(name, ratings) {
  if (!name) return null;
  
  // Direct match
  if (ratings[name]) return ratings[name];
  
  // Try matching by last name + first initial
  const parts = name.trim().split(" ");
  if (parts.length < 2) return null;
  
  // "A. De Minaur" → initial="A", last="De Minaur"
  const isInitialFormat = /^[A-Z]\.$/.test(parts[0]);
  
  if (isInitialFormat) {
    const initial = parts[0].replace(".", "").toLowerCase();
    const lastName = parts.slice(1).join(" ").toLowerCase();
    
    // Search ratings for matching last name + first initial
    for (const [fullName, data] of Object.entries(ratings)) {
      const nameParts = fullName.trim().split(" ");
      if (nameParts.length < 2) continue;
      const fFirst = nameParts[0].toLowerCase();
      const fLast = nameParts.slice(1).join(" ").toLowerCase();
      if (fLast === lastName && fFirst.startsWith(initial)) return data;
    }
    
    // Fuzzy: just last name match
    for (const [fullName, data] of Object.entries(ratings)) {
      const nameParts = fullName.trim().split(" ");
      const fLast = nameParts.slice(1).join(" ").toLowerCase();
      if (fLast === lastName) return data;
    }
  }
  
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Build Elo for both tours in parallel
    const [atpRatings, wtaRatings] = await Promise.all([
      buildEloRatings("atp"),
      buildEloRatings("wta"),
    ]);

    const allRatings = { ...atpRatings, ...wtaRatings };

    // Return summary stats + ratings
    const playerCount = Object.keys(allRatings).length;
    const topPlayers = Object.entries(allRatings)
      .filter(([, v]) => v.matches >= 10)
      .sort(([, a], [, b]) => b.overall - a.overall)
      .slice(0, 20)
      .map(([name, v]) => ({ name, overall: Math.round(v.overall), Clay: Math.round(v.Clay), Grass: Math.round(v.Grass), Hard: Math.round(v.Hard), matches: v.matches }));

    res.setHeader("Cache-Control", "s-maxage=3600"); // cache 1 hour on Vercel edge
    return res.status(200).json({ 
      players: playerCount,
      top20: topPlayers,
      ratings: allRatings,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
