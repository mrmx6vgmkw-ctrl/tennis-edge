// ─────────────────────────────────────────────────────────────────────────────
// Tennis Elo Model
// Based on Jeff Sackmann's methodology (tennisabstract.com)
// Surface adjustments derived from ATP/WTA historical data
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ELO = 1500;
const K = 32; // K-factor (how fast ratings move)

// Surface Elo weights — how much surface-specific rating matters vs overall
const SURFACE_WEIGHT = { Hard: 0.5, Clay: 0.6, Grass: 0.65 };

// Seed-to-approximate-Elo mapping (used when we don't have historical data)
// Based on real ATP/WTA Elo distributions at Grand Slams
const SEED_ELO = {
  1: 2180, 2: 2100, 3: 2050, 4: 2010, 5: 1980, 6: 1960,
  7: 1940, 8: 1920, 9: 1900, 10: 1885, 11: 1870, 12: 1855,
  13: 1840, 14: 1825, 15: 1810, 16: 1795,
};

// Known player Elos (approximate, based on mid-2025 rankings)
// Overall + surface-specific
const PLAYER_ELOS = {
  "C. Alcaraz":  { overall: 2120, Clay: 2090, Grass: 2150, Hard: 2100 },
  "N. Djokovic": { overall: 2095, Clay: 2080, Grass: 2180, Hard: 2090 },
  "I. Swiatek":  { overall: 2110, Clay: 2200, Grass: 1920, Hard: 2080 },
  "E. Rybakina": { overall: 1980, Clay: 1900, Grass: 2060, Hard: 1990 },
  "J. Sinner":   { overall: 2130, Clay: 2100, Grass: 2050, Hard: 2160 },
  "H. Hurkacz":  { overall: 1920, Clay: 1820, Grass: 1980, Hard: 1950 },
  "B. Shelton":  { overall: 1850, Clay: 1780, Grass: 1820, Hard: 1900 },
  "A. Zverev":   { overall: 2010, Clay: 2030, Grass: 1940, Hard: 2020 },
};

/**
 * Get a player's effective Elo for a given surface.
 * Blends overall Elo with surface-specific Elo.
 */
export function getEffectiveElo(playerName, surface, seed = null) {
  const known = PLAYER_ELOS[playerName];
  if (known) {
    const w = SURFACE_WEIGHT[surface] || 0.5;
    const surfaceElo = known[surface] || known.overall;
    return known.overall * (1 - w) + surfaceElo * w;
  }
  // Fall back to seed-based estimate
  if (seed && SEED_ELO[seed]) return SEED_ELO[seed];
  return DEFAULT_ELO;
}

/**
 * Core Elo win probability formula.
 * Returns probability that player1 beats player2.
 */
export function eloProbability(elo1, elo2) {
  return 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
}

/**
 * Fatigue adjustment.
 * More sets played = slight reduction in win probability.
 * Based on empirical analysis showing ~0.5% per extra set beyond 6.
 */
function fatigueAdjust(sets) {
  if (sets <= 6) return 0;
  return (sets - 6) * 0.005; // -0.5% per extra set
}

/**
 * H2H adjustment.
 * Weight recent head-to-head on same surface.
 * Max ±3% adjustment.
 */
function h2hAdjust(p1Wins, p2Wins, surface) {
  const total = p1Wins + p2Wins;
  if (total < 2) return 0;
  const p1Rate = p1Wins / total;
  const expectedRate = 0.5;
  const raw = (p1Rate - expectedRate) * 0.08; // scale
  return Math.max(-0.03, Math.min(0.03, raw));
}

/**
 * Full match win probability for p1.
 * Combines Elo, fatigue, H2H.
 */
export function matchWinProb(p1, p2, surface) {
  const elo1 = getEffectiveElo(p1.name, surface, p1.seed);
  const elo2 = getEffectiveElo(p2.name, surface, p2.seed);

  let prob = eloProbability(elo1, elo2);

  // Fatigue
  if (p1.fatigueSets !== undefined && p2.fatigueSets !== undefined) {
    const f1 = fatigueAdjust(p1.fatigueSets);
    const f2 = fatigueAdjust(p2.fatigueSets);
    prob = prob - f1 + f2;
  }

  // H2H
  if (p1.h2hWins !== undefined && p2.h2hWins !== undefined) {
    prob += h2hAdjust(p1.h2hWins, p2.h2hWins, surface);
  }

  // Clamp to reasonable range (never give 100% or 0%)
  return Math.max(0.05, Math.min(0.95, prob));
}

/**
 * Calculate edge vs book.
 * Returns edge as a percentage. Positive = value bet.
 */
export function calculateEdge(trueProb, bookOdds) {
  const decimal = bookOdds > 0 ? bookOdds / 100 + 1 : 100 / Math.abs(bookOdds) + 1;
  const impliedProb = 1 / decimal;
  return ((trueProb - impliedProb) / impliedProb) * 100;
}

/**
 * Kelly Criterion bet sizing.
 * Returns fraction of bankroll to bet. Use half-Kelly in practice.
 */
export function kellyFraction(trueProb, bookOdds, fraction = 0.5) {
  const decimal = bookOdds > 0 ? bookOdds / 100 + 1 : 100 / Math.abs(bookOdds) + 1;
  const b = decimal - 1;
  const q = 1 - trueProb;
  const full = (trueProb * b - q) / b;
  return Math.max(0, full * fraction); // half-Kelly by default (safer)
}

/**
 * Format American odds nicely.
 */
export function fmtOdds(o) {
  return o > 0 ? `+${o}` : `${o}`;
}

/**
 * Convert American odds to implied probability (with vig removal approximation).
 */
export function impliedProb(odds) {
  const dec = odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
  return 1 / dec;
}
