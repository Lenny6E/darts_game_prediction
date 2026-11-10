/** Rein clientseitige Positionsanalyse. Live-API benötigt CORS-Freigabe durch 3K-Darts. */
const API = 'https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend/';
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
const validDate = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : null; };
const range8 = () => Array(8).fill(0);

async function fetchReport(matchId, signal) {
  let response;
  try {
    response = await fetch(`${API}event/1570/match/${encodeURIComponent(matchId)}/report`, {
      method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', signal,
      headers: {Accept: 'application/json'}
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Der direkte Zugriff auf die 3K-Darts-API ist fehlgeschlagen. Möglicherweise blockiert der Server CORS-Anfragen von dieser Domain oder ist nicht erreichbar. Ohne CORS-Freigabe kann eine rein statische Webseite die Spielberichte nicht direkt abrufen.');
  }
  if (!response.ok) throw new Error(`3K-Darts meldet HTTP ${response.status} für Spiel ${matchId}.`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`Spielbericht ${matchId} hat ein unerwartetes Format.`);
  return payload;
}

function reportBlocks(report) {
  if (!Array.isArray(report) || !report.length) return {error: 'Spielbericht fehlt'};
  const blocks = new Map();
  for (const row of report) {
    if (!row?.id || row.statusCd !== 'FINISH' || !row.participantHome?.displayName || !row.participantGuest?.displayName) {
      return {error: 'Spielbericht ist nicht vollständig abgeschlossen'};
    }
    const block = row.matchReportBlock || {};
    if (block.id == null) return {error: 'Block-ID fehlt'};
    if (!blocks.has(block.id)) blocks.set(block.id, {meta: block, rows: []});
    blocks.get(block.id).rows.push(row);
  }
  if (report.length !== 20 || [...blocks.values()].reduce((n, b) => n + (b.meta.numberOfMatches || 0), 0) !== 20 || new Set(report.map(r => r.id)).size !== 20) {
    return {error: 'Kein vollständiges 20-Spiele-Protokoll'};
  }
  const singles = [...blocks.values()].filter(b => b.rows.some(r => r.matchTypeCd === 'EZ'));
  if (singles.length !== 2 || singles.some(b => b.rows.length !== 8 || b.rows.some(r => r.matchTypeCd !== 'EZ'))) return {error: 'Keine zwei vollständigen Einzelblöcke mit je acht Einzeln'};
  const notes = [];
  for (const field of ['number', 'sortOrder', 'order']) {
    const nums = singles.map(b => b.meta[field]);
    if (nums.every(Number.isInteger) && new Set(nums).size === 2) { singles.sort((a, b) => a.meta[field] - b.meta[field]); break; }
  }
  for (const block of singles) {
    let ordered = false;
    for (const key of ['number', 'matchNumber', 'position', 'sortOrder', 'order']) {
      const values = block.rows.map(r => r[key]);
      const sorted = [...values].sort((a, b) => a - b);
      if (values.every(Number.isInteger) && new Set(values).size === 8 && sorted.every((v,i) => v === sorted[0] + i)) {
        block.rows.sort((a,b) => a[key]-b[key]); ordered = true; break;
      }
    }
    if (!ordered) notes.push('API-Reihenfolge für Einzelpositionen angenommen');
  }
  return {singles, notes};
}

/** Auswertung wie die Python-Logik: Halbwertszeit 5 Spiele, Prior 0,5. */
export function calculatePositions(dataset, teamId, reports) {
  const selected = dataset.teams.find(t => t.id === teamId);
  if (!selected) throw new Error('Gegnerteam fehlt im geladenen Ligadatenstand.');
  const cutoff = Date.now();
  const roster = selected.players || [];
  const names = new Map();
  const stats = new Map();
  for (const player of roster) {
    const key = normalize(player.name);
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(player);
    stats.set(player.id, {observed: range8(), weighted: range8(), blocks: [range8(), range8()], history: []});
  }
  const matches = dataset.matches.filter(m => (m.home === teamId || m.away === teamId) && m.status === 'FINISH' && !m.bye && validDate(m.date) !== null && validDate(m.date) < cutoff && (validDate(m.end_date) === null || validDate(m.end_date) < cutoff)).sort((a,b) => Date.parse(a.date)-Date.parse(b.date));
  const gaps = [];
  let matchesUsed = 0;
  for (const [index, match] of matches.entries()) {
    const raw = reports.get(String(match.id));
    if (!raw) {gaps.push(`Spiel ${match.id}: Bericht fehlt`); continue;}
    const result = reportBlocks(raw);
    if (result.error) {gaps.push(`Spiel ${match.id}: ${result.error}`); continue;}
    for (const note of result.notes) gaps.push(`Spiel ${match.id}: ${note}`);
    const side = match.home === teamId ? 'participantHome' : 'participantGuest';
    const events = [];
    let ambiguous = false;
    for (const [blockIndex, block] of result.singles.entries()) {
      for (const [position, row] of block.rows.entries()) {
        const candidates = names.get(normalize(row[side]?.displayName)) || [];
        if (candidates.length !== 1) {gaps.push(`Spiel ${match.id}: Spieler nicht eindeutig: ${row[side]?.displayName || 'unbekannt'}`); ambiguous = true; break;}
        events.push({id:candidates[0].id, blockIndex, position});
      }
      if (ambiguous) break;
    }
    if (ambiguous) continue;
    matchesUsed++;
    const weight = 0.5 ** ((matches.length - 1 - index) / 5);
    for (const event of events) {
      const stat = stats.get(event.id);
      stat.observed[event.position]++;
      stat.weighted[event.position] += weight;
      stat.blocks[event.blockIndex][event.position]++;
      stat.history.push({match_id:match.id,date:match.date,block:event.blockIndex+1,position:event.position+1});
    }
  }
  const players = roster.map(p => {
    const stat = stats.get(p.id);
    const n = stat.observed.reduce((s,v) => s+v,0);
    const effective = stat.weighted.reduce((s,v) => s+v,0);
    const probabilities = n ? stat.weighted.map(v => (v+0.5)/(effective+4)) : null;
    const most = n ? stat.weighted.indexOf(Math.max(...stat.weighted))+1 : null;
    return {id:p.id,name:p.name,active:p.active,attendance:p.attendance,single_appearances:n,observed_positions:stat.observed,position_probabilities:probabilities,most_likely_position:most,blocks:stat.blocks,history:stat.history,games:p.games,wins:p.wins,strength:p.strength};
  });
  const slot_favorites = Array.from({length:8}, (_, index) => {
    const scores = players.map(p => p.active && p.position_probabilities ? (p.attendance?.p || 0) * p.position_probabilities[index] : 0);
    const total = scores.reduce((s,v) => s+v,0);
    const candidates = total ? players.map((p,i)=>({id:p.id,name:p.name,probability:scores[i]/total})).sort((a,b)=>b.probability-a.probability) : [];
    return {position:index+1,candidates};
  });
  players.sort((a,b)=>Number(!!b.active)-Number(!!a.active) || (b.attendance?.p||0)-(a.attendance?.p||0) || a.name.localeCompare(b.name,'de'));
  return {team_id:teamId,matches_used:matchesUsed,position_count:8,players,slot_favorites,gaps:[...new Set(gaps)],calculated_in_browser:true};
}

/** Berichte nur für die aktuell gewählte Gegnermannschaft abrufen. */
export async function collectPositions(dataset, teamId, onProgress = () => {}, signal) {
  const relevant = dataset.matches.filter(m => (m.home===teamId || m.away===teamId) && m.status==='FINISH' && !m.bye && validDate(m.date) !== null && validDate(m.date) < Date.now() && (validDate(m.end_date) === null || validDate(m.end_date) < Date.now()));
  if (!relevant.length) throw new Error('Für diesen Gegner sind noch keine abgeschlossenen Ligaspiele vorhanden.');
  const reports = new Map();
  const errors = [];
  let completed = 0, next = 0;
  const workers = Array.from({length:Math.min(3,relevant.length)}, async () => {
    while (next < relevant.length) {
      const match = relevant[next++];
      try { reports.set(String(match.id),await fetchReport(match.id,signal)); }
      catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`Spiel ${match.id}: ${e.message}`);
      }
      onProgress(++completed,relevant.length);
    }
  });
  await Promise.all(workers);
  if (!reports.size) throw new Error(errors[0] || 'Keine Spielberichte heruntergeladen.');
  const result = calculatePositions(dataset,teamId,reports);
  result.gaps.push(...errors);
  return {result, downloaded:reports.size, attempted:relevant.length};
}
