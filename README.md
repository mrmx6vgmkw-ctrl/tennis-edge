# Tennis Edge — Deploy Instructions (Phone-Friendly)

## What this is
A tennis betting edge finder with live odds, Elo probability model, and AI analysis.

## Deploy in 5 minutes from your phone

### Step 1: GitHub (2 min)
1. Go to **github.com** on your phone → sign up free
2. Tap **+** → **New repository**
3. Name it `tennis-edge`, keep it Public → tap **Create repository**
4. Tap **uploading an existing file**
5. Upload ALL files from this zip (you may need to do them one by one on mobile)

### Step 2: Vercel (2 min)
1. Go to **vercel.com** → sign up with your GitHub account
2. Tap **Add New Project**
3. Select your `tennis-edge` repo
4. Leave all settings default → tap **Deploy**
5. Wait ~30 seconds → you get a live URL like `tennis-edge-xxx.vercel.app`

### Step 3: Use it
1. Open your Vercel URL on your phone
2. Enter your Odds API key when prompted
3. Live tennis odds load automatically

## Your Odds API key
Get a free key at **the-odds-api.com** (500 requests/month, no card needed)

## Files in this zip
- `index.html` — entry point
- `vite.config.js` — build config
- `package.json` — dependencies
- `vercel.json` — deploy config
- `src/main.jsx` — React entry
- `src/App.jsx` — full app (self-contained)
- `src/elo.js` — Elo model reference
- `src/oddsApi.js` — odds fetcher reference
