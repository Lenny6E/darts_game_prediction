/** Statischer Taktik-Assistent. Keine API, keine erfundenen Spielerdaten. */
import {probability, optimalAssignment} from './model.js';

export const TACTICS = {
  balanced: {title:'Ausgewogen', description:'Hoher Erwartungswert, mit kleiner Strafe für schwache Gegneraufstellungen.'},
  attack: {title:'Angriff', description:'Maximiert die geschätzte Chance auf mindestens 5 gewonnene Einzel.'},
  safe: {title:'Sicherheit', description:'Maximiert die erwarteten Einzelsiege im ungünstigsten Zehntel der möglichen Gegneraufstellungen.'},
  surprise: {title:'Überraschung', description:'Maximiert die geschätzte Chance auf mindestens 7 gewonnene Einzel.'}
};
const mean = values => values.reduce((s,x)=>s+x,0)/values.length;
const quantile = (values,q) => {const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor((sorted.length-1)*q)];};
const clamp = n => Math.min(1,Math.max(0,n));
const number = x => typeof x==='number' && Number.isFinite(x) ? x : null;
const positionWeights = (p,block) => {
  const global=p.position_probabilities;
  if (!Array.isArray(global) || global.length!==8) return null;
  // Blockhäufigkeit wird mit geglätteter, aktualitätsgewichteter Saisonverteilung vermischt.
  // Bei wenigen Beobachtungen dominiert die globale Verteilung.
  const counts=p.blocks?.[block];
  if (!Array.isArray(counts)||counts.length!==8) return global.map(v=>Math.max(0,v));
  const sum=counts.reduce((s,v)=>s+(number(v)??0),0);
  return global.map((v,i)=>Math.max(0,(4*(number(v)??0)+(number(counts[i])??0))/(4+sum)));
};
function rng(seed){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};}
function hashSeed(values){let h=2166136261;for(const c of JSON.stringify(values)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function weightedChoice(items,weights,random){const sum=weights.reduce((a,v)=>a+v,0);if(sum<=0) return Math.floor(random()*items.length);let r=random()*sum;for(let i=0;i<items.length;i++){r-=weights[i];if(r<=0)return i;}return items.length-1;}
function sampleOpponentOrder(players,block,random){
  // Ziehung einer vollständigen, eindeutig besetzten Positionenfolge. Im Gegensatz
  // zur unabhängigen Top-1-Prognose kann kein Spieler zweimal im Block vorkommen.
  const remaining=[...players];const result=[];
  for(let slot=0;slot<8;slot++){
    const weights=remaining.map(p=>{
      const pos=positionWeights(p,block);
      const attendance=clamp(number(p.attendance?.p)??.5);
      return Math.max(1e-8,(pos?.[slot]??1/8)*(0.15+0.85*attendance));
    });
    const index=weightedChoice(remaining,weights,random);
    result.push(remaining.splice(index,1)[0]);
  }
  return result;
}
function selectRoster(players,random){
  const remaining=[...players], result=[];
  while(result.length<8){const weights=remaining.map(p=>Math.max(.01,clamp(number(p.attendance?.p)??.5)));const index=weightedChoice(remaining,weights,random);result.push(remaining.splice(index,1)[0]);}
  return result;
}
/** @returns Samples vollständiger gegnerischer Einzelblöcke, jeweils 8 eindeutige IDs. */
export function predictOpponentLineups(opponents,positionAnalysis,{block=0,samples=96,seed=undefined}={}){
  if(![0,1].includes(block))throw new Error('Der Einzelblock muss 1 oder 2 sein.');
  if(!Array.isArray(opponents)||opponents.length<8||opponents.length>16)throw new Error('Bitte 8 bis 16 gegnerische Spieler auswählen.');
  if(new Set(opponents.map(p=>p.id)).size!==opponents.length)throw new Error('Doppelte Gegner-ID in der Auswahl.');
  if(opponents.some(p=>number(p.strength)==null))throw new Error('Mindestens ein Gegner hat keine auswertbare Einzelstärke.');
  const indexed=new Map((positionAnalysis?.players||[]).map(p=>[String(p.id),p]));
  if(!positionAnalysis?.matches_used||!opponents.some(p=>indexed.get(String(p.id))?.position_probabilities))throw new Error('Bitte zuerst im Bereich „Gegnerpositionen“ historische Spielberichte laden und analysieren.');
  const enriched=opponents.map(p=>({...p,...(indexed.get(String(p.id))||{}),strength:p.strength,attendance:p.attendance}));
  const missing=enriched.filter(p=>!positionWeights(p,block));
  if(missing.length)throw new Error(`Keine Positionshistorie für: ${missing.map(p=>p.name).join(', ')}. Bitte Spieler mit Positionshistorie auswählen.`);
  if(!Number.isInteger(samples)||samples<16||samples>500)throw new Error('Die Stichprobengröße muss zwischen 16 und 500 liegen.');
  const random=rng(seed??hashSeed([block,enriched.map(p=>p.id),positionAnalysis.matches_used]));
  const lineups=[];
  for(let i=0;i<samples;i++){
    const roster=enriched.length===8?enriched:selectRoster(enriched,random);
    lineups.push(sampleOpponentOrder(roster,block,random));
  }
  return lineups;
}
/** Gewichtet für jeden eigenen Spieler die Siegchance je Position über alle Szenarien. */
export function calculatePositionWinMatrix(own,lineups){
  if(own.length!==8||new Set(own.map(p=>p.id)).size!==8||own.some(p=>number(p.strength)==null))throw new Error('Genau 8 eigene Spieler mit Einzelstärke auswählen.');
  if(!lineups.length||lineups.some(l=>l.length!==8||new Set(l.map(p=>p.id)).size!==8))throw new Error('Ungültige Gegneraufstellungen.');
  const matrix=own.map(p=>Array.from({length:8},(_,slot)=>mean(lineups.map(l=>probability(p,l[slot])))));
  if(matrix.some(row=>row.some(p=>number(p)==null)))throw new Error('Einzelstärken fehlen.');
  return matrix;
}
const winTail=(chances,minimum)=>{
  const dp=Array(9).fill(0);dp[0]=1;
  for(let i=0;i<8;i++){
    const p=chances[i];for(let k=i+1;k>=0;k--) dp[k]=(k>0?dp[k-1]*p:0)+(k<=i?dp[k]*(1-p):0);
  }
  return dp.slice(minimum).reduce((a,b)=>a+b,0);
};
function scoreOrder(order,own,lineups,strategy){
  const scenarioMeans=[];let attack=0,surprise=0;
  for(const opponent of lineups){
    const chances=order.map((index,slot)=>probability(own[index],opponent[slot]));
    scenarioMeans.push(chances.reduce((a,b)=>a+b,0));
    if(strategy==='attack')attack+=winTail(chances,5);
    if(strategy==='surprise')surprise+=winTail(chances,7);
  }
  if(strategy==='attack')return attack/lineups.length;
  if(strategy==='surprise')return surprise/lineups.length;
  if(strategy==='safe')return quantile(scenarioMeans,.1);
  const avg=mean(scenarioMeans);return avg-.2*(avg-quantile(scenarioMeans,.1));
}
function metrics(order,own,lineups){
  const scenarioMeans=[],wins5=[],wins7=[];
  for(const opponent of lineups){
    const chances=order.map((i,slot)=>probability(own[i],opponent[slot]));
    scenarioMeans.push(chances.reduce((a,b)=>a+b,0));
    wins5.push(winTail(chances,5));wins7.push(winTail(chances,7));
  }
  return {expected:mean(scenarioMeans),downside:quantile(scenarioMeans,.1),prob5:mean(wins5),prob7:mean(wins7)};
}
/** Exakte Optimierung für Erwartungswert; lokale Tauschsuche für nichtlineare Taktikziele. */
export function optimizeLineup(strategy,own,lineups,positionMatrix){
  if(!TACTICS[strategy])throw new Error('Unbekannte Strategie.');
  if(own.length!==8)throw new Error('Genau 8 eigene Spieler notwendig.');
  // Die Zuordnungsmatrix hat Spieler in Zeilen und Positionen in Spalten.
  const balanced=optimalAssignment(positionMatrix).assignment; // Spielerindex -> Position
  const baseline=Array(8);balanced.forEach((slot,idx)=>{baseline[slot]=idx;});
  let best=[...baseline],bestScore=scoreOrder(best,own,lineups,strategy);
  // Startpunkte: deterministisch, stabil zwischen wiederholten Berechnungen.
  const random=rng(hashSeed([strategy,own.map(p=>p.id),lineups[0].map(p=>p.id)]));
  const starts=[baseline,Array.from({length:8},(_,i)=>i)];
  for(let k=0;k<10;k++){
    const order=Array.from({length:8},(_,i)=>i);
    for(let i=7;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
    starts.push(order);
  }
  for(const start of starts){
    let order=[...start],value=scoreOrder(order,own,lineups,strategy);
    for(let pass=0;pass<12;pass++){
      let next=null,nextScore=value;
      for(let i=0;i<7;i++)for(let j=i+1;j<8;j++){
        const candidate=[...order];[candidate[i],candidate[j]]=[candidate[j],candidate[i]];
        const score=scoreOrder(candidate,own,lineups,strategy);
        if(score>nextScore+1e-10){nextScore=score;next=candidate;}
      }
      if(!next)break;
      order=next;value=nextScore;
    }
    if(value>bestScore+1e-10){best=order;bestScore=value;}
  }
  return {strategy,order:best,objective:bestScore,...metrics(best,own,lineups),positions:best.map((index,slot)=>({position:slot+1,player:own[index],win_probability:positionMatrix[index][slot]}))};
}
export function compareStrategies(own,lineups){
  const matrix=calculatePositionWinMatrix(own,lineups);
  const strategies=Object.keys(TACTICS).map(key=>optimizeLineup(key,own,lineups,matrix));
  return {matrix,strategies,samples:lineups.length};
}
