import { useState, useEffect, useCallback } from "react";

const C = {
  bg: "#0d0b08", surface: "#120f0b", card: "#171310", border: "#2a2318",
  ball: "#e8ff00", chalk: "#f0ebe0", chalkDim: "#7a7060",
  bad: "#ff5533", upset: "#ff9900",
  text: "#d4cfc8", textDim: "#55504a", textMuted: "#302c28",
};

// ── PROBABILITY MODEL ────────────────────────────────────────────────────────

function impliedProb(odds) {
  const d = odds > 0 ? odds/100+1 : 100/Math.abs(odds)+1;
  return 1/d;
}
function noVigProb(odds1, odds2) {
  const i1 = impliedProb(odds1), i2 = impliedProb(odds2);
  const total = i1 + i2;
  return { p1: i1/total, p2: i2/total };
}
function eloExpected(e1, e2) { return 1/(1+Math.pow(10,(e2-e1)/400)); }

// Find player in Elo ratings (handles "A. LastName" format from Odds API)
function findElo(name, ratings, surface) {
  if (!name || !ratings) return null;

  const clean = s => s.toLowerCase().replace(/[^a-z ]/g,"").trim();
  const eloResult = (data) => ({ overall: data.overall, surface: data[surface] || data.overall });

  // 1. Direct match
  if (ratings[name]) return eloResult(ratings[name]);

  // 2. Case-insensitive direct match
  const nameLower = clean(name);
  for (const [k,v] of Object.entries(ratings)) {
    if (clean(k) === nameLower) return eloResult(v);
  }

  // 3. "A. De Minaur" → try matching first initial + last name
  const parts = name.trim().split(" ");
  if (parts.length >= 2) {
    const isInitial = /^[A-Z]\.?$/.test(parts[0]);
    const lastName = clean(parts.slice(1).join(" "));
    const initial = parts[0].replace(".","").toLowerCase();

    for (const [fullName, data] of Object.entries(ratings)) {
      const fp = fullName.trim().split(" ");
      if (fp.length < 2) continue;
      const fFirst = fp[0].toLowerCase();
      const fLast = clean(fp.slice(1).join(" "));
      if (fLast === lastName && (isInitial ? fFirst.startsWith(initial) : fFirst === initial)) {
        return eloResult(data);
      }
    }

    // 4. Last name only fallback (risky but better than nothing)
    const lastMatches = Object.entries(ratings).filter(([k]) => {
      const fp = k.trim().split(" ");
      return fp.length >= 2 && clean(fp.slice(1).join(" ")) === lastName;
    });
    if (lastMatches.length === 1) return eloResult(lastMatches[0][1]);
  }

  return null;
}

function lineMoveAdjust(currentOdds, openOdds) {
  if (!openOdds) return 0;
  const dec = o => o > 0 ? o/100+1 : 100/Math.abs(o)+1;
  const movePct = (dec(openOdds) - dec(currentOdds)) / dec(openOdds);
  if (movePct > 0.05) return +0.02;
  if (movePct < -0.05) return -0.02;
  return 0;
}

function matchProb(p1, p2, surface, openOdds1, openOdds2, eloRatings) {
  const elo1 = findElo(p1.name, eloRatings, surface);
  const elo2 = findElo(p2.name, eloRatings, surface);

  let prob;
  if (elo1 && elo2) {
    // Both players found — use real Elo (blend overall + surface)
    const sw = surface === "Grass" ? 0.65 : surface === "Clay" ? 0.6 : 0.5;
    const e1 = elo1.overall * (1-sw) + elo1.surface * sw;
    const e2 = elo2.overall * (1-sw) + elo2.surface * sw;
    prob = eloExpected(e1, e2);
  } else {
    // Unknown players — fall back to no-vig market probability
    const { p1: base1 } = noVigProb(p1.odds, p2.odds);
    prob = base1;
  }

  // Line movement adjustment
  prob += lineMoveAdjust(p1.odds, openOdds1) - lineMoveAdjust(p2.odds, openOdds2);

  return Math.max(0.05, Math.min(0.95, prob));
}

function calcEdge(trueP, odds) {
  const imp = impliedProb(odds);
  return ((trueP - imp) / imp) * 100;
}
function calcKelly(trueP, odds) {
  const b = (odds>0?odds/100+1:100/Math.abs(odds)+1)-1;
  return Math.max(0,(trueP*b-(1-trueP))/b*0.5);
}
function fmt(o) { return o>0?`+${o}`:`${o}`; }

// ── ODDS FETCHER (via /api/odds serverless proxy) ───────────────────────────────
// API calls go through /api/odds — our Vercel serverless proxy
// This runs server-side so no CORS issues
const BASE  = "https://api.the-odds-api.com/v4";

function inferSurf(key) {
  if (key.includes("wimbledon")||key.includes("halle")||key.includes("queens")) return "Grass";
  if (key.includes("french_open")||key.includes("monte_carlo")||key.includes("madrid")||
      key.includes("italian")||key.includes("barcelona")||key.includes("hamburg")||
      key.includes("munich")||key.includes("strasbourg")||key.includes("charleston")||
      key.includes("german")||key.includes("stuttgart")||key.includes("roland")) return "Clay";
  return "Hard";
}

function inferTier(key) {
  if (key.includes("itf")) return "ITF";
  if (key.includes("challenger")) return "Challenger";
  if (key.includes("atp_double")||key.includes("wta_double")) return "Tour";
  return "Grand Slam / Masters";
}
function fmtTournament(key) {
  return key.replace("tennis_atp_","ATP ").replace("tennis_wta_","WTA ")
    .replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase())
    .replace("Aus Open Singles","Australian Open").replace("Us Open","US Open")
    .replace("Wta ","WTA ").replace("Atp ","ATP ");
}
function fmtName(raw) {
  if (!raw) return "Unknown";
  const p = raw.trim().split(" ");
  if (p.length===1) return raw;
  return `${p[0][0]}. ${p.slice(1).join(" ")}`;
}
function bestOdds(bookmakers, home, away) {
  let b1=null,b2=null,o1=null,o2=null,first=true;
  const dec=o=>o>0?o/100+1:100/Math.abs(o)+1;
  for (const bk of bookmakers) {
    const mkt=bk.markets?.find(m=>m.key==="h2h"); if(!mkt) continue;
    const h=mkt.outcomes?.find(o=>o.name===home),a=mkt.outcomes?.find(o=>o.name===away);
    if(!h||!a) continue;
    if(b1===null||dec(h.price)>dec(b1)) b1=h.price;
    if(b2===null||dec(a.price)>dec(b2)) b2=a.price;
    if(first){o1=h.price;o2=a.price;first=false;}
  }
  return {b1,b2,o1:o1||b1,o2:o2||b2};
}

async function proxyFetch(url) {
  // Route through /api/odds Vercel serverless function
  // Pass the full Odds API URL as a query param so the server fetches it
  const proxyUrl = `/api/odds?target=${encodeURIComponent(url)}`;
  const r = await fetch(proxyUrl);
  if (!r.ok) throw new Error(`Proxy error: ${r.status}`);
  return r;
}

async function fetchTennis(apiKey) {
  // Step 1: get active sports via our /api/odds serverless proxy
  const sRes = await proxyFetch(`${BASE}/sports/?apiKey=${apiKey}&all=true`);
  if (sRes.status === 401) throw new Error("INVALID_KEY");
  if (!sRes.ok) throw new Error(`Sports list failed: ${sRes.status}`);
  const allSports = await sRes.json();
  const remaining = sRes.headers.get("x-requests-remaining");

  const activeTennis = Array.isArray(allSports)
    ? allSports.filter(s => s.key?.startsWith("tennis_") && s.active !== false)
    : [];

  if (!activeTennis.length) return { matches: [], quota: { remaining }, activeSports: [] };

  // Step 2: fetch odds for each active tennis sport
  const results = [];
  let lastRemaining = remaining;

  for (const sport of activeTennis) {
    try {
      const res = await proxyFetch(
        `${BASE}/sports/${sport.key}/odds/?apiKey=${apiKey}&regions=us,uk&markets=h2h&oddsFormat=american`
      );
      if (!res.ok) continue;
      const data = await res.json();
      lastRemaining = res.headers.get("x-requests-remaining") || lastRemaining;
      if (!Array.isArray(data)) continue;

      const surface = inferSurf(sport.key);
      const tournament = fmtTournament(sport.key);

      for (const ev of data) {
        if (!ev.bookmakers?.length) continue;
        const {b1,b2,o1,o2} = bestOdds(ev.bookmakers, ev.home_team, ev.away_team);
        if (!b1||!b2) continue;
        const p1name = fmtName(ev.home_team), p2name = fmtName(ev.away_team);
        const trueP1 = matchProb(
          {name:p1name, odds:b1},
          {name:p2name, odds:b2},
          surface, o1, o2, window._eloRatings||null
        );
        // Skip matches where odds are extreme (>1500) — match already in progress and lopsided
        const maxOdds = Math.max(Math.abs(b1), Math.abs(b2));
        if (maxOdds > 1500) continue;

        const commenceTime = new Date(ev.commence_time);
        const isLive = commenceTime < new Date();

        results.push({
          id: ev.id, sport: sport.key, tournament, surface,
          time: commenceTime.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",timeZoneName:"short"}),
          p1: {name:p1name, seed:null, form:[]},
          p2: {name:p2name, seed:null, form:[]},
          ml: { p1Odds:b1, p2Odds:b2, trueP1, clv:{p1Open:o1,p2Open:o2}, keyFactor:`${tournament} · ${surface} · ${inferTier(sport.key)}` },
          props: [], _live: isLive,
        });
      }
    } catch { continue; }
  }

  return { matches: results, quota: { remaining: lastRemaining }, activeSports: activeTennis.map(s=>s.title||s.key) };
}
// ── DEMO ──────────────────────────────────────────────────────────────────────
const DEMO = [
  { id:"d1",tournament:"Wimbledon",surface:"Grass",time:"13:00 BST",_live:false,
    p1:{name:"C. Alcaraz",seed:3,form:[1,1,1,0,1]},p2:{name:"N. Djokovic",seed:2,form:[1,0,1,1,1]},
    ml:{p1Odds:-145,p2Odds:+122,trueP1:null,clv:{p1Open:-130,p2Open:+110},keyFactor:"Alcaraz 3-0 in last 3 grass h2h. Djokovic knee concern."},
    props:[{market:"Total Games",dir:"Over",line:37.5,bookOdds:-115,trueProb:0.62,note:"Both avg 38.2 games on grass"},{market:"Alcaraz Aces",dir:"Over",line:9.5,bookOdds:-108,trueProb:0.58,note:"11.3 aces/match at Wimbledon"}]},
  { id:"d2",tournament:"Wimbledon",surface:"Grass",time:"11:00 BST",_live:false,
    p1:{name:"I. Swiatek",seed:1,form:[1,1,0,1,1]},p2:{name:"E. Rybakina",seed:4,form:[1,1,1,0,1]},
    ml:{p1Odds:-180,p2Odds:+155,trueP1:null,clv:{p1Open:-200,p2Open:+170},keyFactor:"Swiatek struggles on grass. Line steamed on name value."},
    props:[{market:"Total Games",dir:"Under",line:21.5,bookOdds:-112,trueProb:0.60,note:"Rybakina serve ends matches fast"},{market:"Rybakina Aces",dir:"Over",line:7.5,bookOdds:-125,trueProb:0.65,note:"9.8 aces/match on grass"}]},
  { id:"d3",tournament:"Roland Garros",surface:"Clay",time:"15:00 CEST",_live:false,
    p1:{name:"J. Sinner",seed:1,form:[1,1,1,1,0]},p2:{name:"H. Hurkacz",seed:7,form:[1,0,1,1,1]},
    ml:{p1Odds:-320,p2Odds:+260,trueP1:null,clv:{p1Open:-280,p2Open:+230},keyFactor:"Sinner dominant on clay. Hurkacz serve loses edge on slow surface."},
    props:[{market:"Total Games",dir:"Over",line:41.5,bookOdds:-118,trueProb:0.64,note:"Clay SF average 43.1 games"},{market:"Match Duration",dir:"Over",line:165.5,bookOdds:-105,trueProb:0.56,note:"Clay SF run 172 min average"}]},
];
function withElo(ms) {
  return ms.map(m=>({...m,ml:{...m.ml,trueP1:m.ml.trueP1??matchProb(
    {name:m.p1.name, odds:m.ml.p1Odds},
    {name:m.p2.name, odds:m.ml.p2Odds},
    m.surface, m.ml.clv?.p1Open, m.ml.clv?.p2Open, window._eloRatings||null
  )}}));
}

// ── UI COMPONENTS ─────────────────────────────────────────────────────────────
function CourtSVG({surface}) {
  const cc=surface==="Clay"?"#c4692a":surface==="Grass"?"#2d6b2d":"#1a3a5c";
  const lc=surface==="Clay"?"#e8d5c0":surface==="Grass"?"#e8f5e8":"#c8dff0";
  return (<svg width="52" height="36" viewBox="0 0 52 36"><rect width="52" height="36" rx="2" fill={cc} opacity="0.22"/><rect x="4" y="4" width="44" height="28" fill="none" stroke={lc} strokeWidth="0.8" opacity="0.5"/><line x1="26" y1="4" x2="26" y2="32" stroke={lc} strokeWidth="0.6" opacity="0.4"/><line x1="4" y1="18" x2="48" y2="18" stroke={lc} strokeWidth="1.2" opacity="0.7"/><circle cx="14" cy="12" r="2" fill="#e8ff00" opacity="0.9"/></svg>);
}
function Pill({surface}) {
  const m={Clay:["#3a1800","#c4692a"],Grass:["#0a200a","#2d8b2d"],Hard:["#071828","#1a7ab0"]};
  const [bg,fg]=m[surface]||["#222","#888"];
  return <span style={{background:bg,color:fg,border:`1px solid ${fg}50`,fontSize:9,fontWeight:800,padding:"2px 6px",borderRadius:2,letterSpacing:1,fontFamily:"monospace"}}>{surface.toUpperCase()}</span>;
}
function Dots({form}) {
  if(!form?.length) return null;
  return <div style={{display:"flex",gap:3}}>{form.map((w,i)=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:w?C.ball:C.bad}}/>)}</div>;
}
function WinBar({p}) {
  const pct=Math.round(p*100);
  return (<div><div style={{display:"flex",height:5,borderRadius:3,overflow:"hidden",marginBottom:3}}><div style={{width:`${pct}%`,background:C.ball}}/><div style={{flex:1,background:"#2a2318"}}/></div><div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:C.ball,fontSize:11,fontFamily:"monospace",fontWeight:700}}>{pct}%</span><span style={{color:C.textDim,fontSize:11,fontFamily:"monospace"}}>{100-pct}%</span></div></div>);
}
function EdgeBar({e}) {
  const cl=Math.min(Math.max(e,-20),20),pos=e>=0;
  return (<div style={{display:"flex",alignItems:"center",gap:8}}><div style={{flex:1,height:3,background:C.textMuted,borderRadius:2,position:"relative",overflow:"hidden"}}><div style={{position:"absolute",left:"50%",top:0,width:1,height:"100%",background:C.border}}/><div style={{position:"absolute",height:"100%",width:`${Math.abs(cl)/20*50}%`,left:pos?"50%":`${50-Math.abs(cl)/20*50}%`,background:pos?C.ball:C.bad}}/></div><span style={{fontFamily:"monospace",fontSize:11,color:pos?C.ball:C.bad,minWidth:48,textAlign:"right"}}>{e>0?"+":""}{e.toFixed(1)}%</span></div>);
}

function Setup({onSave,onDemo}) {
  const [key,setKey]=useState("");
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
      <div style={{maxWidth:400,width:"100%"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:28}}>
          <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="8" fill="#e8ff00"/><path d="M3 9 Q6 5 9 9 Q12 13 15 9" fill="none" stroke="white" strokeWidth="1.2"/><path d="M3 9 Q6 13 9 9 Q12 5 15 9" fill="none" stroke="white" strokeWidth="1.2"/></svg>
          <span style={{color:C.ball,fontSize:12,fontFamily:"monospace",fontWeight:800,letterSpacing:2}}>TENNIS EDGE</span>
        </div>
        <div style={{color:C.chalk,fontSize:20,fontWeight:800,marginBottom:8}}>Connect live odds</div>
        <div style={{color:C.chalkDim,fontSize:13,lineHeight:1.7,marginBottom:24}}>
          Free API key from <a href="https://the-odds-api.com" target="_blank" rel="noreferrer" style={{color:C.ball}}>the-odds-api.com</a> — 500 req/month, no card needed.
        </div>
        <input value={key} onChange={e=>setKey(e.target.value)} placeholder="Paste API key here"
          style={{width:"100%",background:C.card,border:`1px solid ${C.border}`,color:C.chalk,padding:"12px 14px",borderRadius:6,fontSize:13,fontFamily:"monospace",outline:"none",marginBottom:10}}/>
        <button onClick={()=>key.trim()&&onSave(key.trim())} disabled={!key.trim()}
          style={{width:"100%",background:key.trim()?C.ball:C.border,color:key.trim()?"#000":C.textDim,border:"none",padding:"12px",borderRadius:6,fontSize:12,fontWeight:800,fontFamily:"monospace",cursor:key.trim()?"pointer":"default",marginBottom:8,letterSpacing:1}}>
          CONNECT LIVE ODDS →
        </button>
        <button onClick={onDemo} style={{width:"100%",background:"transparent",color:C.textDim,border:`1px solid ${C.border}`,padding:"10px",borderRadius:6,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>
          Try demo data
        </button>
        <div style={{marginTop:20,padding:14,background:C.card,borderRadius:6,border:`1px solid ${C.border}`}}>
          <div style={{color:C.ball,fontSize:10,fontFamily:"monospace",letterSpacing:1,marginBottom:8}}>HOW TO GET YOUR KEY</div>
          {["1. Go to the-odds-api.com","2. Click 'Get API Key'","3. Sign up with email (free)","4. Copy key and paste above"].map((s,i)=>(
            <div key={i} style={{color:C.chalkDim,fontSize:11,fontFamily:"monospace",marginBottom:3}}>{s}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MLCard({match,onAI,busy,rank}) {
  const {ml,p1,p2}=match;
  if(!ml.trueP1) return null;
  const e1=calcEdge(ml.trueP1,ml.p1Odds),e2=calcEdge(1-ml.trueP1,ml.p2Odds);
  const k1=calcKelly(ml.trueP1,ml.p1Odds),k2=calcKelly(1-ml.trueP1,ml.p2Odds);
  const hasEdge=Math.max(e1,e2)>3,isUpset=e2>4,aKey=`ml-${match.id}`;
  return (
    <div style={{background:C.card,border:`1px solid ${hasEdge?"#e8ff0025":C.border}`,borderRadius:8,marginBottom:12,overflow:"hidden"}}>
      <div style={{padding:"12px 14px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <CourtSVG surface={match.surface}/>
          <div style={{flex:1}}>
            <div style={{display:"flex",gap:6,marginBottom:3,flexWrap:"wrap",alignItems:"center"}}>
              {rank&&<span style={{color:"#000",background:C.ball,fontSize:9,fontWeight:900,padding:"1px 5px",borderRadius:2,fontFamily:"monospace"}}>#{rank}</span>}
              <span style={{color:C.chalkDim,fontSize:10,fontFamily:"monospace"}}>{match.tournament}</span>
              <Pill surface={match.surface}/>
              <span style={{color:C.textMuted,fontSize:10,fontFamily:"monospace"}}>{match.time}</span>
              {match._live&&<span style={{background:"#001a00",color:"#00ff44",border:"1px solid #00ff4440",fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:2,fontFamily:"monospace"}}>LIVE</span>}
              {isUpset&&<span style={{background:"#2a1400",color:C.upset,border:`1px solid ${C.upset}40`,fontSize:9,fontWeight:800,padding:"1px 5px",borderRadius:2,fontFamily:"monospace"}}>UPSET VALUE</span>}
            </div>
            <div style={{color:C.chalk,fontSize:13,fontWeight:800}}>
              {p1.seed?`[${p1.seed}] `:""}{p1.name} <span style={{color:C.textMuted,fontWeight:400}}>vs</span> {p2.seed?`[${p2.seed}] `:""}{p2.name}
            </div>
          </div>
        </div>
        <WinBar p={ml.trueP1}/>
      </div>
      {[{pl:p1,odds:ml.p1Odds,trueP:ml.trueP1,k:k1,e:e1,open:ml.clv.p1Open},{pl:p2,odds:ml.p2Odds,trueP:1-ml.trueP1,k:k2,e:e2,open:ml.clv.p2Open}].map((row,i)=>(
        <div key={i} style={{padding:"10px 14px",borderBottom:i===0?`1px solid ${C.border}`:"none"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:6}}>
            <div style={{minWidth:130}}>
              <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
                <span style={{color:C.chalk,fontSize:13,fontWeight:800}}>{row.pl.name}</span>
                {row.e>3&&<span style={{background:C.ball,color:"#000",fontSize:9,fontWeight:900,padding:"1px 4px",borderRadius:2}}>VALUE</span>}
              </div>
              <Dots form={row.pl.form}/>
            </div>
            <div style={{display:"flex",gap:12,flex:1,flexWrap:"wrap"}}>
              {[["NOW",fmt(row.odds),C.chalk],["OPEN",fmt(row.open),C.textDim],["TRUE%",`${(row.trueP*100).toFixed(0)}%`,C.text],["KELLY",row.k>0?`${(row.k*100).toFixed(1)}%`:"—",row.e>3?C.ball:C.textDim]].map(([l,v,col])=>(
                <div key={l}><div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace",letterSpacing:1}}>{l}</div><div style={{color:col,fontSize:12,fontFamily:"monospace",fontWeight:600}}>{v}</div></div>
              ))}
            </div>
          </div>
          <EdgeBar e={row.e}/>
        </div>
      ))}
      <div style={{padding:"9px 14px",borderTop:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <div style={{color:C.textDim,fontSize:11,flex:1}}>{ml.keyFactor}</div>
        <button onClick={()=>onAI(match,aKey)} disabled={busy===aKey}
          style={{background:"transparent",border:`1px solid ${hasEdge?C.ball:C.border}`,color:hasEdge?C.ball:C.textDim,padding:"4px 12px",borderRadius:3,cursor:"pointer",fontSize:10,fontFamily:"monospace",fontWeight:800,letterSpacing:1,whiteSpace:"nowrap"}}>
          {busy===aKey?"···":"ASK AI"}
        </button>
      </div>
    </div>
  );
}

function PropsCard({match,onAI,busy}) {
  if(!match.props?.length) return null;
  const ec=match.props.filter(p=>calcEdge(p.trueProb??0.5,p.bookOdds)>3).length;
  return (
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,marginBottom:12,overflow:"hidden"}}>
      <div style={{padding:"11px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{color:C.chalk,fontSize:13,fontWeight:800}}>{match.p1.name} vs {match.p2.name}</div>
          <div style={{display:"flex",gap:6,marginTop:3,alignItems:"center"}}><span style={{color:C.textMuted,fontSize:10,fontFamily:"monospace"}}>{match.tournament}</span><Pill surface={match.surface}/></div>
        </div>
        <div style={{textAlign:"right"}}><div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace"}}>VALUE</div><div style={{color:ec>0?C.ball:C.textDim,fontSize:20,fontWeight:900,fontFamily:"monospace"}}>{ec}</div></div>
      </div>
      <div style={{padding:"0 14px 6px"}}>
        {match.props.map((prop,i)=>{
          const e_=calcEdge(prop.trueProb??0.5,prop.bookOdds),k_=calcKelly(prop.trueProb??0.5,prop.bookOdds),hasEdge=e_>3,pKey=`prop-${match.id}-${i}`;
          return (
            <div key={i} style={{borderTop:`1px solid ${C.border}`,padding:"10px 0"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:6}}>
                <div style={{minWidth:150,flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <span style={{color:C.chalk,fontSize:12,fontWeight:700}}>{prop.market}</span>
                    <span style={{color:C.chalkDim,fontSize:12}}>{prop.dir} {prop.line}</span>
                    {hasEdge&&<span style={{background:C.ball,color:"#000",fontSize:9,fontWeight:900,padding:"1px 4px",borderRadius:2}}>VALUE</span>}
                  </div>
                  <div style={{color:C.textDim,fontSize:10,marginTop:2}}>{prop.note}</div>
                </div>
                <div style={{display:"flex",gap:12}}>
                  {[["BOOK",fmt(prop.bookOdds)],["TRUE%",prop.trueProb?`${(prop.trueProb*100).toFixed(0)}%`:"—"],["KELLY",k_>0?`${(k_*100).toFixed(1)}%`:"—"]].map(([l,v])=>(
                    <div key={l}><div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace"}}>{l}</div><div style={{color:l==="KELLY"&&k_>0?C.ball:C.text,fontSize:12,fontFamily:"monospace",fontWeight:600}}>{v}</div></div>
                  ))}
                </div>
                <button onClick={()=>onAI(prop,match,pKey)} disabled={busy===pKey}
                  style={{background:"transparent",border:`1px solid ${hasEdge?C.ball:C.border}`,color:hasEdge?C.ball:C.textDim,padding:"3px 10px",borderRadius:3,cursor:"pointer",fontSize:10,fontFamily:"monospace",fontWeight:700}}>
                  {busy===pKey?"···":"AI"}
                </button>
              </div>
              <EdgeBar e={e_}/>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Drawer({analysis,onClose}) {
  if(!analysis) return null;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(5,4,3,0.92)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={onClose}>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderTop:`2px solid ${C.ball}`,borderRadius:"12px 12px 0 0",padding:"22px 20px 36px",width:"100%",maxWidth:540,maxHeight:"75vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{width:30,height:3,background:C.border,borderRadius:2,margin:"0 auto 18px"}}/>
        <div style={{color:C.ball,fontSize:10,fontFamily:"monospace",letterSpacing:2,marginBottom:5}}>AI ANALYSIS</div>
        <div style={{color:C.chalk,fontSize:15,fontWeight:800,marginBottom:14}}>{analysis.title}</div>
        {analysis.loading
          ?<div style={{color:C.chalkDim,fontFamily:"monospace",fontSize:13}}><span style={{color:C.ball}}>▋</span> Reading the match...</div>
          :<div style={{color:C.text,fontSize:14,lineHeight:1.8,fontFamily:"Georgia,serif"}}>{analysis.text}</div>}
        {analysis.stats&&(
          <div style={{display:"flex",gap:18,marginTop:18,paddingTop:14,borderTop:`1px solid ${C.border}`}}>
            {analysis.stats.map(([l,v,col])=>(
              <div key={l}><div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace",letterSpacing:1}}>{l}</div><div style={{color:col||C.chalk,fontSize:17,fontWeight:900,fontFamily:"monospace"}}>{v}</div></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey,setApiKey]=useState(()=>{try{return localStorage.getItem("te_key")||""}catch{return ""}});
  const [mode,setMode]=useState(apiKey?"live":"setup");
  const [matches,setMatches]=useState([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [tab,setTab]=useState("ml");
  const [filter,setFilter]=useState("all");
  const [analysis,setAnalysis]=useState(null);
  const [busy,setBusy]=useState(null);
  const [quota,setQuota]=useState(null);
  const [activeSports,setActiveSports]=useState([]);
  const [eloRatings,setEloRatings]=useState(null);
  const [eloStatus,setEloStatus]=useState("loading");

  const load=useCallback(async(key)=>{
    setLoading(true);setError(null);
    try {
      const {matches:raw,quota:q,activeSports:as}=await fetchTennis(key);
      setQuota(q);setActiveSports(as||[]);
      if(!raw.length){
        setError("No active tennis odds found right now — showing demo data.");
        setMatches(withElo(DEMO));
      } else {
        setMatches(raw);
      }
    } catch(err){
      if(err.message==="INVALID_KEY") setError("Invalid API key — double-check at the-odds-api.com");
      else setError(`Connection error: ${err.message}. Showing demo data.`);
      setMatches(withElo(DEMO));
    } finally { setLoading(false); }
  },[]);

  // Fetch real Elo ratings from Sackmann data on mount
  useEffect(()=>{
    fetch("/api/elo")
      .then(r=>r.json())
      .then(d=>{
        if(d.ratings){
          setEloRatings(d.ratings);
          window._eloRatings = d.ratings; // make available to fetchTennis
          setEloStatus(`${d.players} players`);
        } else setEloStatus("elo unavailable");
      })
      .catch(()=>setEloStatus("elo unavailable"));
  },[]);

  useEffect(()=>{
    if(mode==="live"&&apiKey) load(apiKey);
    if(mode==="demo") setMatches(withElo(DEMO));
  },[mode]);

  const saveKey=key=>{try{localStorage.setItem("te_key",key)}catch{}setApiKey(key);setMode("live");};

  const claude=async(prompt)=>{
    const r=await fetch("/api/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:1000,messages:[{role:"user",content:prompt}]})});
    const d=await r.json();
    return d.content?.map(b=>b.text||"").join("")||"Unavailable.";
  };

  const aiML=async(match,key)=>{
    setBusy(key);
    const {ml,p1,p2}=match;
    const e1=calcEdge(ml.trueP1,ml.p1Odds),e2=calcEdge(1-ml.trueP1,ml.p2Odds),best=Math.max(e1,e2);
    const title=`${p1.name} vs ${p2.name} — Moneyline`;
    const stats=[["EDGE",`${best>0?"+":""}${best.toFixed(1)}%`,best>0?C.ball:C.bad],["VERDICT",best>5?"STRONG BET":best>3?"BET":best>0?"LEAN":"PASS",best>3?C.ball:C.bad]];
    setAnalysis({title,loading:true,text:"",stats});
    // Find Elo ratings for context
    const elo1 = findElo(p1.name, window._eloRatings, match.surface);
    const elo2 = findElo(p2.name, window._eloRatings, match.surface);
    const eloCtx = elo1 && elo2
      ? `Elo ratings: ${p1.name} overall=${elo1.overall} ${match.surface}=${elo1.surface} / ${p2.name} overall=${elo2.overall} ${match.surface}=${elo2.surface} (source: tennisabstract.com)`
      : "Elo ratings: not available for these players";

    const text=await claude(`You are a sharp tennis moneyline analyst. Be concise and specific.
Match: ${p1.name} vs ${p2.name} — ${match.tournament} (${match.surface})
Current lines: ${p1.name} ${fmt(ml.p1Odds)} / ${p2.name} ${fmt(ml.p2Odds)}
Opening lines: ${p1.name} ${fmt(ml.clv.p1Open)} / ${p2.name} ${fmt(ml.clv.p2Open)}
${eloCtx}
True win probability (our model): ${p1.name} ${(ml.trueP1*100).toFixed(0)}% / ${p2.name} ${((1-ml.trueP1)*100).toFixed(0)}%
Edge vs book: ${p1.name} ${e1.toFixed(1)}% / ${p2.name} ${e2.toFixed(1)}%
Surface: ${match.surface}
Line movement: ${ml.p1Odds !== ml.clv.p1Open ? `${p1.name} moved from ${fmt(ml.clv.p1Open)} to ${fmt(ml.p1Odds)}` : "no significant movement"}

3–4 sentences. Cover: where the real edge is, what the line movement signals, surface-specific factors, and the single biggest risk. Tennis terminology. No preamble.`).catch(()=>"Error — try again.");
    setAnalysis({title,loading:false,text,stats});setBusy(null);
  };

  const aiProp=async(prop,match,key)=>{
    setBusy(key);
    const e_=calcEdge(prop.trueProb??0.5,prop.bookOdds),k_=calcKelly(prop.trueProb??0.5,prop.bookOdds);
    const title=`${match.p1.name} vs ${match.p2.name} — ${prop.market} ${prop.dir} ${prop.line}`;
    const stats=[["EDGE",`${e_>0?"+":""}${e_.toFixed(1)}%`,e_>0?C.ball:C.bad],["KELLY",k_>0?`${(k_*100).toFixed(1)}%`:"—",C.chalk],["VERDICT",e_>5?"STRONG BET":e_>3?"BET":e_>0?"LEAN":"PASS",e_>3?C.ball:C.bad]];
    setAnalysis({title,loading:true,text:"",stats});
    const text=await claude(`Tennis prop analyst. Concise.
Match: ${match.p1.name} vs ${match.p2.name} — ${match.tournament} (${match.surface})
Prop: ${prop.market} ${prop.dir} ${prop.line} at ${fmt(prop.bookOdds)} · Edge: ${e_.toFixed(1)}%
Context: ${prop.note}
3–4 sentences. Real edge or noise? Surface driver? Risk? No preamble.`).catch(()=>"Error — try again.");
    setAnalysis({title,loading:false,text,stats});setBusy(null);
  };

  if(mode==="setup") return <Setup onSave={saveKey} onDemo={()=>setMode("demo")}/>;

  const mlE=matches.reduce((n,m)=>n+(m.ml.trueP1&&calcEdge(m.ml.trueP1,m.ml.p1Odds)>3?1:0)+(m.ml.trueP1&&calcEdge(1-m.ml.trueP1,m.ml.p2Odds)>3?1:0),0);
  const prE=matches.reduce((n,m)=>n+(m.props||[]).filter(p=>calcEdge(p.trueProb??0.5,p.bookOdds)>3).length,0);
  // Sort all matches by best edge descending
  const sorted=[...matches].sort((a,b)=>{
    const ea=Math.max(calcEdge(a.ml.trueP1||0.5,a.ml.p1Odds),calcEdge(1-(a.ml.trueP1||0.5),a.ml.p2Odds));
    const eb=Math.max(calcEdge(b.ml.trueP1||0.5,b.ml.p1Odds),calcEdge(1-(b.ml.trueP1||0.5),b.ml.p2Odds));
    return eb-ea;
  });
  const shown=filter==="value"
    ?sorted.filter(m=>tab==="ml"?m.ml.trueP1&&(calcEdge(m.ml.trueP1,m.ml.p1Odds)>3||calcEdge(1-m.ml.trueP1,m.ml.p2Odds)>3):(m.props||[]).some(p=>calcEdge(p.trueProb??0.5,p.bookOdds)>3))
    :sorted;

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <style>{`*{box-sizing:border-box}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#2a2318}input::placeholder{color:#302c28}`}</style>

      <div style={{padding:"16px 14px 0",maxWidth:620,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <svg width="15" height="15" viewBox="0 0 18 18"><circle cx="9" cy="9" r="8" fill="#e8ff00"/><path d="M3 9 Q6 5 9 9 Q12 13 15 9" fill="none" stroke="white" strokeWidth="1.2"/><path d="M3 9 Q6 13 9 9 Q12 5 15 9" fill="none" stroke="white" strokeWidth="1.2"/></svg>
              <span style={{color:C.ball,fontSize:11,fontFamily:"monospace",fontWeight:800,letterSpacing:2}}>TENNIS EDGE</span>
              {mode==="demo"&&<span style={{color:C.textDim,fontSize:9,fontFamily:"monospace"}}>DEMO</span>}
            </div>
            {quota?.remaining&&<div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace"}}>{quota.remaining} API req left</div>}
            {eloStatus&&<div style={{color:eloStatus.includes("players")?C.ball:C.textMuted,fontSize:9,fontFamily:"monospace",marginTop:1}}>⚡ Elo: {eloStatus}</div>}
            {activeSports.length>0&&<div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace",marginTop:1}}>↳ {activeSports.slice(0,3).join(" · ")}{activeSports.length>3?` +${activeSports.length-3} more`:""}</div>}
          </div>
          <div style={{display:"flex",gap:14,textAlign:"right"}}>
            <div><div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace"}}>ML</div><div style={{color:C.ball,fontSize:20,fontWeight:900,fontFamily:"monospace",lineHeight:1}}>{mlE}</div></div>
            <div><div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace"}}>PROPS</div><div style={{color:C.ball,fontSize:20,fontWeight:900,fontFamily:"monospace",lineHeight:1}}>{prE}</div></div>
          </div>
        </div>

        <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
          {[["ml","MONEYLINE"],["props","PROPS"]].map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)} style={{background:tab===k?C.ball:"transparent",color:tab===k?"#000":C.textDim,border:`1px solid ${tab===k?C.ball:C.border}`,padding:"5px 14px",borderRadius:3,cursor:"pointer",fontSize:10,fontWeight:800,fontFamily:"monospace",letterSpacing:1}}>{l}</button>
          ))}
          <div style={{flex:1}}/>
          {mode==="live"&&<button onClick={()=>load(apiKey)} disabled={loading} style={{background:"transparent",color:loading?C.textMuted:C.chalkDim,border:`1px solid ${C.border}`,padding:"5px 10px",borderRadius:3,cursor:"pointer",fontSize:10,fontFamily:"monospace"}}>{loading?"···":"↻"}</button>}
          <button onClick={()=>setFilter(f=>f==="all"?"value":"all")} style={{background:filter==="value"?"rgba(232,255,0,0.08)":"transparent",color:filter==="value"?C.ball:C.textDim,border:`1px solid ${filter==="value"?"#e8ff0040":C.border}`,padding:"5px 12px",borderRadius:3,cursor:"pointer",fontSize:10,fontFamily:"monospace",fontWeight:700}}>VALUE</button>
          <button onClick={()=>{try{localStorage.removeItem("te_key")}catch{}setMode("setup")}} style={{background:"transparent",color:C.textMuted,border:"none",cursor:"pointer",fontSize:12}}>⚙</button>
        </div>

        {error&&<div style={{background:"#1a0800",border:"1px solid #ff553330",borderRadius:6,padding:"9px 12px",marginBottom:10,color:C.bad,fontSize:11,fontFamily:"monospace",lineHeight:1.5}}>{error}</div>}
      </div>

      <div style={{padding:"0 14px 28px",maxWidth:620,margin:"0 auto"}}>
        {loading
          ?<div style={{color:C.chalkDim,fontFamily:"monospace",fontSize:13,padding:"40px 0",textAlign:"center"}}><span style={{color:C.ball}}>▋</span> Fetching live tennis odds...</div>
          :shown.length===0
            ?<div style={{color:C.textDim,fontFamily:"monospace",fontSize:12,padding:"40px 0",textAlign:"center"}}>No matches. Try ALL filter or hit ↻ to refresh.</div>
            :tab==="ml"
              ?shown.map((m,i)=><MLCard key={m.id||i} match={m} rank={i+1} onAI={aiML} busy={busy}/>)
              :shown.filter(m=>m.props?.length>0).length===0
                ?<div style={{color:C.textDim,fontFamily:"monospace",fontSize:12,padding:"40px 16px",textAlign:"center",lineHeight:1.8}}>Props markets require a paid Odds API tier.<br/>Moneyline edge is available now — switch to MONEYLINE tab.</div>
                :shown.map((m,i)=><PropsCard key={m.id||i} match={m} onAI={aiProp} busy={busy}/>)
        }
        <div style={{color:C.textMuted,fontSize:9,fontFamily:"monospace",textAlign:"center",lineHeight:1.8,marginTop:4}}>
          ELO MODEL ESTIMATES · NOT FINANCIAL ADVICE · BET RESPONSIBLY
        </div>
      </div>

      <Drawer analysis={analysis} onClose={()=>setAnalysis(null)}/>
    </div>
  );
}
