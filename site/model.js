export const DEFAULT_TEAM = 175057;
export const percent = n => n == null ? 'unbekannt' : new Intl.NumberFormat('de-DE', {style:'percent', maximumFractionDigits:1, minimumFractionDigits:1}).format(n);
export function nextMatch(data, tid, now = Date.now()) {
  if (!data.schedule_complete) return null;
  return data.matches.filter(m => (m.home === tid || m.away === tid) && !m.bye &&
    !['FINISH','CANCEL','CANCELLED'].includes(m.status) && m.date && Date.parse(m.date) >= now)
    .sort((a,b) => Date.parse(a.date)-Date.parse(b.date))[0] ?? null;
}
export function probability(a,b) {
  if (a.strength == null || b.strength == null) return null;
  const x = a.strength/(1-a.strength), y = b.strength/(1-b.strength);
  return x/(x+y);
}
export function optimalAssignment(matrix) {
  const n = matrix.length, m = matrix[0]?.length ?? 0;
  if (!n || m < n || m > 16 || matrix.some(row => row.length !== m || row.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)))
    throw new Error('Bitte mindestens einen eigenen Spieler und mindestens ebenso viele Gegner auswählen (höchstens 16 Gegner).');
  // Exact bitmask DP. Unlike greedy matching, this evaluates every allowed assignment.
  const states = new Float64Array(1 << m).fill(-Infinity);
  const parent = new Int32Array(1 << m).fill(-1);
  states[0] = 0;
  let best = -Infinity, bestMask = 0;
  for (let mask=0; mask<(1<<m); mask++) {
    if (!Number.isFinite(states[mask])) continue;
    let bits=mask, row=0; while(bits) {bits &= bits-1; row++;}
    if (row === n) {if(states[mask] > best) {best=states[mask]; bestMask=mask;} continue;}
    for(let j=0; j<m; j++) if(!(mask & (1<<j))) {
      const target=mask|(1<<j), candidate=states[mask]+matrix[row][j];
      if(candidate > states[target]) {states[target]=candidate; parent[target]=j;}
    }
  }
  const assignment = Array(n); let mask=bestMask;
  for(let i=n-1; i>=0; i--) {assignment[i]=parent[mask]; mask ^= 1<<assignment[i];}
  return {expected:best, assignment};
}
export function scenario(own, opponents) {
  const matrix=own.map(a=>opponents.map(b=>probability(a,b)));
  if(matrix.some(row=>row.some(v=>v==null))) throw new Error('Für mindestens einen Spieler fehlen auswertbare Einzel.');
  return {matrix, ...optimalAssignment(matrix)};
}
export function cellKind(p) {return p > .5 ? 'win' : p < .5 ? 'loss' : 'even';}
export function eligible(player, when) {
  // Match Python's UTC registration-date comparison; independent of visitor timezone.
  const day = new Date(when).toISOString().slice(0,10);
  return !!player.registered_from && player.registered_from <= day && (!player.registered_to || player.registered_to >= day);
}
