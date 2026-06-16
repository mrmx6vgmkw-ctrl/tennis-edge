export const config = { maxDuration: 30 };

const K = 32;
const DEFAULT = 1500;

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/"/g,"").trim());
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h,i) => obj[h] = (vals[i]||"").replace(/"/g,"").trim());
    return obj;
  });
}

function surf(s) {
  if (!s) return "Hard";
  s = s.toLowerCase();
  if (s.includes("clay")) return "Clay";
  if (s.includes("grass")) return "Grass";
  return "Hard";
}

async function fetchCSV(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    return parseCSV(await r.text());
  } catch { return []; }
}

async function buildRatings(tour) {
  const base = `https://raw.githubusercontent.com/JeffSackmann/tennis_${tour}/master`;
  const prefix = tour === "atp" ? "atp" : "wta";
  const ratings = {};

  function get(name) {
    if (!ratings[name]) ratings[name] = { overall: DEFAULT, Hard: DEFAULT, Clay: DEFAULT, Grass: DEFAULT, n: 0 };
    return ratings[name];
  }

  function update(w, l, surface) {
    const rw = get(w), rl = get(l);
    const exp = 1 / (1 + Math.pow(10, (rl.overall - rw.overall) / 400));
    rw.overall += K * (1 - exp); rl.overall += K * -exp;
    const s = surface;
    const exps = 1 / (1 + Math.pow(10, (rl[s] - rw[s]) / 400));
    rw[s] += K * (1 - exps); rl[s] += K * -exps;
    rw.n++; rl.n++;
  }

  // Only fetch last 2 years to stay within Vercel timeout
  const years = [2024, 2025, 2026];
  for (const year of years) {
    for (const suffix of ["", "_qual_chall"]) {
      const rows = await fetchCSV(`${base}/${prefix}_matches${suffix}_${year}.csv`);
      for (const m of rows) {
        if (m.winner_name && m.loser_name) update(m.winner_name, m.loser_name, surf(m.surface));
      }
    }
  }
  return ratings;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const [atp, wta] = await Promise.all([buildRatings("atp"), buildRatings("wta")]);
    const ratings = { ...atp, ...wta };
    res.setHeader("Cache-Control", "s-maxage=3600");
    return res.status(200).json({ players: Object.keys(ratings).length, ratings });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
