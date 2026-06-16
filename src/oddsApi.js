// ─────────────────────────────────────────────────────────────────────────────
// Live Odds Fetcher — The Odds API (free tier)
// Docs: https://the-odds-api.com/liveapi/guides/v4/
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = "https://api.the-odds-api.com/v4";

// Tennis sport keys on The Odds API
const TENNIS_SPORTS = [
  "tennis_atp_wimbledon",
  "tennis_wta_wimbledon",
  "tennis_atp_french_open",
  "tennis_wta_french_open",
  "tennis_atp_us_open",
  "tennis_wta_us_open",
  "tennis_atp_australian_open",
  "tennis_wta_australian_open",
  "tennis_atp_double",   // non-slam ATP
  "tennis_wta_double",   // non-slam WTA
];

/**
 * Fetch all live/upcoming tennis events with moneyline odds.
 * Returns structured match objects ready for the app.
 */
export async function fetchLiveOdds(apiKey) {
  const results = [];
  const errors = [];

  // Try each tennis sport key; some may have no events (off-season)
  for (const sport of TENNIS_SPORTS) {
    try {
      const url = `${BASE_URL}/sports/${sport}/odds/?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american`;
      const res = await fetch(url);

      if (res.status === 401) throw new Error("Invalid API key");
      if (res.status === 422) continue; // sport not available right now — normal
      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      // Parse remaining requests from headers
      const remaining = res.headers.get("x-requests-remaining");
      const used = res.headers.get("x-requests-used");

      for (const event of data) {
        const parsed = parseEvent(event, sport);
        if (parsed) results.push(parsed);
      }

      // Return quota info from first successful call
      if (results.length > 0) {
        results._quota = { remaining, used };
      }

    } catch (err) {
      if (err.message === "Invalid API key") throw err;
      errors.push({ sport, error: err.message });
    }
  }

  return { matches: results, errors };
}

/**
 * Fetch player props for a specific event.
 * Note: props availability depends on your Odds API tier.
 */
export async function fetchProps(apiKey, eventId, sport) {
  const markets = [
    "player_aces",
    "player_double_faults",
    "alternate_totals",
  ].join(",");

  const url = `${BASE_URL}/sports/${sport}/events/${eventId}/odds/?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return parseProps(data);
  } catch {
    return [];
  }
}

/**
 * Parse a raw Odds API event into our app's match format.
 */
function parseEvent(event, sport) {
  if (!event.bookmakers || event.bookmakers.length === 0) return null;

  const p1Name = formatPlayerName(event.home_team);
  const p2Name = formatPlayerName(event.away_team);

  // Find the best (most competitive) odds across bookmakers
  const { p1Odds, p2Odds, openP1, openP2 } = extractOdds(event.bookmakers, event.home_team, event.away_team);
  if (!p1Odds || !p2Odds) return null;

  const surface = inferSurface(sport, event.commence_time);
  const tournament = inferTournament(sport);
  const round = inferRound(event.id);

  return {
    id: event.id,
    sport,
    tournament,
    surface,
    round,
    time: formatTime(event.commence_time),
    commenceTime: event.commence_time,
    p1: { name: p1Name, seed: null, nat: "", form: [] },
    p2: { name: p2Name, seed: null, nat: "", form: [] },
    ml: {
      p1Odds,
      p2Odds,
      trueP1: null, // filled by Elo model
      clv: { p1Open: openP1 || p1Odds, p2Open: openP2 || p2Odds },
      surfaceRecord: { p1: "—", p2: "—" },
      h2h: { p1Wins: 0, p2Wins: 0, lastResult: null, lastMatch: "—" },
      fatigue: { p1Sets: 0, p2Sets: 0 },
      keyFactor: `${tournament} · ${surface} · Live odds`,
    },
    props: [], // populated separately if prop API available
    _live: true,
  };
}

/**
 * Extract best available odds across all bookmakers.
 * We take the best price for each side (line shopping).
 */
function extractOdds(bookmakers, homeTeam, awayTeam) {
  let bestP1 = null, bestP2 = null;
  let openP1 = null, openP2 = null;
  let firstBook = true;

  for (const book of bookmakers) {
    const market = book.markets?.find(m => m.key === "h2h");
    if (!market) continue;

    const homeOutcome = market.outcomes?.find(o => o.name === homeTeam);
    const awayOutcome = market.outcomes?.find(o => o.name === awayTeam);
    if (!homeOutcome || !awayOutcome) continue;

    const p1 = homeOutcome.price;
    const p2 = awayOutcome.price;

    // Best odds = highest value for bettor
    if (bestP1 === null || isBetterOdds(p1, bestP1)) bestP1 = p1;
    if (bestP2 === null || isBetterOdds(p2, bestP2)) bestP2 = p2;

    // Use first book as "open" approximation
    if (firstBook) {
      openP1 = p1;
      openP2 = p2;
      firstBook = false;
    }
  }

  return { p1Odds: bestP1, p2Odds: bestP2, openP1, openP2 };
}

function isBetterOdds(newOdds, currentBest) {
  // Higher odds = better for bettor
  // For positive odds: higher number is better
  // For negative odds: less negative is better
  const toDecimal = o => o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1;
  return toDecimal(newOdds) > toDecimal(currentBest);
}

function parseProps(data) {
  if (!data?.bookmakers) return [];
  const props = [];

  for (const book of data.bookmakers) {
    for (const market of (book.markets || [])) {
      for (const outcome of (market.outcomes || [])) {
        props.push({
          market: formatMarketName(market.key),
          player: formatPlayerName(outcome.description || ""),
          dir: outcome.name === "Over" ? "Over" : "Under",
          line: outcome.point,
          bookOdds: outcome.price,
          trueProb: null, // filled by model
          note: `${book.title} · ${formatMarketName(market.key)}`,
        });
      }
    }
  }

  return props;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function formatPlayerName(raw) {
  if (!raw) return "Unknown";
  // "Djokovic N." or "N. Djokovic" → normalize
  const parts = raw.trim().split(" ");
  if (parts.length === 1) return raw;
  // If last part looks like an initial (single letter + optional dot)
  if (/^[A-Z]\.?$/.test(parts[parts.length - 1])) {
    return `${parts[parts.length - 1].replace(".", "")}. ${parts.slice(0, -1).join(" ")}`;
  }
  // First initial + last name
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

function inferSurface(sport, commenceTime) {
  if (sport.includes("wimbledon")) return "Grass";
  if (sport.includes("french_open")) return "Clay";
  if (sport.includes("australian_open")) return "Hard";
  if (sport.includes("us_open")) return "Hard";
  // For non-slam, guess by month
  const month = new Date(commenceTime).getMonth() + 1;
  if (month >= 4 && month <= 6) return "Clay"; // clay season
  if (month === 6 || month === 7) return "Grass"; // grass season
  return "Hard";
}

function inferTournament(sport) {
  const map = {
    tennis_atp_wimbledon: "Wimbledon",
    tennis_wta_wimbledon: "Wimbledon",
    tennis_atp_french_open: "Roland Garros",
    tennis_wta_french_open: "Roland Garros",
    tennis_atp_us_open: "US Open",
    tennis_wta_us_open: "US Open",
    tennis_atp_australian_open: "Australian Open",
    tennis_wta_australian_open: "Australian Open",
    tennis_atp_double: "ATP Tour",
    tennis_wta_double: "WTA Tour",
  };
  return map[sport] || "Tennis";
}

function inferRound(eventId) {
  // Odds API doesn't give round info — we'd need a secondary source
  // Return blank and let the UI handle it gracefully
  return "";
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

function formatMarketName(key) {
  const map = {
    player_aces: "Aces",
    player_double_faults: "Double Faults",
    alternate_totals: "Total Games",
    h2h: "Match Winner",
  };
  return map[key] || key;
}

/**
 * Check how many API requests remain.
 * Call this to show quota in UI.
 */
export async function checkQuota(apiKey) {
  try {
    const res = await fetch(`${BASE_URL}/sports/?apiKey=${apiKey}`);
    return {
      remaining: res.headers.get("x-requests-remaining"),
      used: res.headers.get("x-requests-used"),
    };
  } catch {
    return { remaining: "—", used: "—" };
  }
}
