import assert from 'node:assert/strict';
import {predictOpponentLineups,calculatePositionWinMatrix,compareStrategies, optimizeLineup} from '../site/tactics.js';
const own=Array.from({length:8},(_,i)=>({id:i+1,name:`Eigen ${i+1}`,strength:.35+i*.05}));
const opponents=Array.from({length:10},(_,i)=>({id:i+101,name:`Gegner ${i+1}`,strength:.38+i*.04,attendance:{p:.5+i*.035}}));
const positions={matches_used:8,players:opponents.map((p,i)=>({id:p.id,position_probabilities:Array.from({length:8},(_,s)=>s===i%8?.5:1/14),blocks:[Array.from({length:8},(_,s)=>s===i%8?4:0),Array.from({length:8},(_,s)=>s===(i+1)%8?4:0)]}))};
const a=predictOpponentLineups(opponents,positions,{samples:96,block:0});
const b=predictOpponentLineups(opponents,positions,{samples:96,block:0});
assert.deepEqual(a.map(row=>row.map(x=>x.id)),b.map(row=>row.map(x=>x.id)),'Reproduzierbar');
assert(a.every(row=>row.length===8&&new Set(row.map(x=>x.id)).size===8),'Keine doppelten Spieler');
const second=predictOpponentLineups(opponents,positions,{samples:96,block:1});
assert.notDeepEqual(a.map(row=>row.map(x=>x.id)),second.map(row=>row.map(x=>x.id)),'Unterschiedliche Blöcke');
const m=calculatePositionWinMatrix(own,a);
assert.equal(m.length,8);assert(m.every(row=>row.length===8&&row.every(p=>p>=0&&p<=1)));
const result=compareStrategies(own,a);
assert.equal(result.strategies.length,4);
for(const p of result.strategies){
  assert.equal(new Set(p.order).size,8);assert.equal(p.positions.length,8);
  assert(p.expected>=0&&p.expected<=8);assert(p.downside>=0&&p.downside<=8);
  assert(p.prob5>=0&&p.prob5<=1);assert(p.prob7>=0&&p.prob7<=1);
  assert(p.prob7<=p.prob5+1e-12);
}
assert.throws(()=>predictOpponentLineups(opponents,{matches_used:0,players:[]}),/historische Spielberichte/);
assert.throws(()=>calculatePositionWinMatrix(own.slice(0,7),a),/Genau 8/);
console.log('Alle Tests bestanden (Szenarien, 2 Blöcke, Zuordnung, 4 Strategien, Fehlerfälle).');
