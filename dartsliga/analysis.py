"""Conservative, transparent statistics, attendance and assignment."""
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache


def date(value):
    if not value:
        return None
    try:
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
    except ValueError:
        return None


def norm(text):
    return ' '.join(text.casefold().split())


def matches(snapshot):
    found = {}
    for rnd in snapshot['rounds'].values():
        for match in (rnd or {}).get('matches', []):
            found[match['id']] = match
    return list(found.values())


def side(match, tid):
    for key in ('participantHome', 'participantGuest'):
        if match.get(key, {}).get('id') == tid:
            return key
    return None


def next_match(snapshot, tid, now=None):
    now = now or datetime.now(timezone.utc)
    if any(rnd is None for rnd in snapshot['rounds'].values()):
        return None  # a missing round may contain an earlier fixture
    upcoming = [m for m in matches(snapshot) if side(m, tid)
                and m.get('statusCd') not in ('FINISH', 'CANCEL', 'CANCELLED')
                and not m.get('byeHome') and not m.get('byeAway')
                and date(m.get('datePlanned')) and date(m['datePlanned']) >= now]
    return min(upcoming, key=lambda m: date(m['datePlanned'])) if upcoming else None


def wilson(k, n):
    if not n:
        return (0.0, 1.0)
    z = 1.96
    p = k / n
    den = 1 + z*z/n
    center = (p + z*z/(2*n))/den
    half = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/den
    return max(0, center-half), min(1, center+half)


def attendance(observations):
    """Chronological booleans, one per complete, eligible team match."""
    n = len(observations)
    if not n:
        return dict(p=None, low=0, high=1, n=0, k=0, recent=None)
    k = sum(observations)
    low, high = wilson(k, n)
    return dict(p=(k+1)/(n+2), low=low, high=high, n=n, k=k,
                recent=sum(observations[-5:])/len(observations[-5:]))


def complete_report(report, expected_games=20):
    if not isinstance(report, list) or not report:
        return False
    blocks = {r.get('matchReportBlock', {}).get('id'): r.get('matchReportBlock', {}).get('numberOfMatches', 0) for r in report}
    expected = sum(blocks.values())
    return (None not in blocks and expected == expected_games and len({r.get('id') for r in report}) == expected
            and all(r.get('statusCd') == 'FINISH' and r.get('participantHome', {}).get('displayName')
                    and r.get('participantGuest', {}).get('displayName') for r in report))


def team_players(snapshot, tid, cutoff=None):
    """Member IDs for roster/results; scoped names only for report joins.

    Report participants lack member IDs in the observed API. Ambiguous scoped
    names invalidate attendance observations instead of merging identities.
    """
    cutoff = cutoff or datetime.now(timezone.utc)
    detail = snapshot['teams'].get(str(tid)) or {}
    roster = detail.get('participant', {}).get('teamSeason', {}).get('teamMembers', [])
    team = next((t for t in snapshot['participants'] if t['id'] == tid), {})
    team_id = team.get('team', {}).get('id')
    players = {}
    for item in roster:
        mid = item.get('member', {}).get('id')
        if mid:
            players[mid] = dict(id=mid, name=item.get('displayName', ''), roster=item,
                                games=0, wins=0, legs=0, lost_legs=0, darts=0, score=0, history=[], observations=[])
    for item in (snapshot.get('results') or {}).get('playerResults', []):
        if item.get('team', {}).get('id') != team_id:
            continue
        mid = item.get('member', {}).get('id')
        if mid and mid not in players:
            players[mid] = dict(id=mid, name=item['displayName'], roster={}, games=0, wins=0,
                                legs=0, lost_legs=0, darts=0, score=0, history=[], observations=[])
        if mid:
            players[mid]['portal_results'] = item
    names = defaultdict(list)
    for player in players.values():
        names[norm(player['name'])].append(player)
    history = [m for m in matches(snapshot) if side(m, tid) and m.get('statusCd') == 'FINISH'
               and date(m.get('datePlanned')) and date(m['datePlanned']) < cutoff
               and (not date(m.get('endDate')) or date(m['endDate']) < cutoff)
               and not m.get('byeHome') and not m.get('byeAway')]
    history.sort(key=lambda m: date(m['datePlanned']))
    gaps = []
    for match_index, match in enumerate(history):
        report = snapshot['reports'].get(str(match['id']))
        structure = match.get('phase', {}).get('matchReportStructure', '8xEZ;4xDP;8xEZ')
        expected_games = sum(int(n) for n in re.findall(r'(\d+)x[A-Z]+', structure))
        if not complete_report(report, expected_games):
            gaps.append(f"Spiel {match['id']}: Bericht fehlt/unvollständig; keine Abwesenheiten abgeleitet.")
            continue
        key = side(match, tid)
        own_home = key == 'participantHome'
        appeared = set()
        resolved = True
        for row in report:
            participant = row[key]
            parts = [participant['displayName']] if row.get('matchTypeCd') == 'EZ' else re.split(r'\s+&\s+', participant['displayName'])
            for name in parts:
                candidates = names[norm(name)]
                if len(candidates) != 1:
                    resolved = False
                    gaps.append(f"Spiel {match['id']}: Name nicht eindeutig im Kader: {name}")
                    continue
                player = candidates[0]
                appeared.add(player['id'])
                if row.get('matchTypeCd') != 'EZ':
                    continue
                a, b = (row.get('legsHome'), row.get('legsAway')) if own_home else (row.get('legsAway'), row.get('legsHome'))
                if a is None or b is None or a == b:
                    continue
                player['games'] += 1
                player['wins'] += a > b
                player['legs'] += a
                player['lost_legs'] += b
                darts, score = participant.get('darts', 0), participant.get('score', 0)
                if darts > 0 and score > 0:
                    player['darts'] += darts
                    player['score'] += score
                opponent = row['participantGuest' if own_home else 'participantHome']['displayName']
                player['history'].append(dict(date=match['datePlanned'], match_id=match['id'], opponent=opponent, legs=f'{a}:{b}', won=a>b))
        if resolved:
            when = date(match['datePlanned']).date().isoformat()
            for player in players.values():
                roster = player['roster']
                if roster and roster.get('dateFrom', '0000') <= when <= roster.get('dateTo', '9999'):
                    player['observations'].append(player['id'] in appeared)
    for player in players.values():
        player['attendance'] = attendance(player['observations'])
        player['average'] = 3*player['score']/player['darts'] if player['darts'] else None
        player['strength'] = (player['wins']+2)/(player['games']+4) if player['games'] else None
        player['active'] = (bool(player['roster']) and player['roster'].get('dateFrom', '0000') <= cutoff.date().isoformat()
                            <= player['roster'].get('dateTo', '9999'))
    return list(players.values()), list(dict.fromkeys(gaps))


def win_probability(a, b):
    """Bradley-Terry from Beta(2,2) shrunk single win rates; uncalibrated."""
    pa, pb = a.get('strength'), b.get('strength')
    if pa is None or pb is None:
        return None
    odds_a, odds_b = pa/(1-pa), pb/(1-pb)
    return odds_a/(odds_a+odds_b)


def optimal_assignment(matrix):
    """Exact rectangular maximum-sum matching; each row and column once."""
    n = len(matrix)
    m = len(matrix[0]) if n else 0
    if n == 0 or m < n or m > 16 or any(len(row) != m for row in matrix):
        raise ValueError('1–16 Gegner und mindestens so viele Gegner wie eigene Spieler erforderlich.')
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for row in matrix for v in row):
        raise ValueError('Ungültige Wahrscheinlichkeit.')

    @lru_cache(None)
    def solve(i, used):
        if i == n:
            return 0.0, ()
        best = (-1.0, ())
        for j in range(m):
            if not used & (1 << j):
                total, rest = solve(i+1, used | (1 << j))
                candidate = (matrix[i][j] + total, (j,) + rest)
                if candidate[0] > best[0]:
                    best = candidate
        return best
    return solve(0, 0)


def scenario(own, opponents):
    matrix = [[win_probability(a, b) for b in opponents] for a in own]
    if any(v is None for row in matrix for v in row):
        raise ValueError('Für mindestens einen Spieler fehlen auswertbare Einzel.')
    total, assignment = optimal_assignment(matrix)
    return dict(expected=total, matrix=matrix,
                pairs=[dict(own=own[i]['name'], opponent=opponents[j]['name'], p=matrix[i][j]) for i, j in enumerate(assignment)])


# --- Positions- und Aufstellungsprognose (8 Einzel je Block) ---

def _single_blocks(report, slots=8):
    """Return ordered single blocks. API list order is the documented fallback.

    Never derive a position from an opaque database ID. If all rows in a block
    contain a suitable explicit position/order, prefer it over list order.
    """
    blocks = {}
    for row in report:
        if row.get('matchTypeCd') != 'EZ':
            continue
        block = row.get('matchReportBlock') or {}
        bid = block.get('id')
        if bid is None:
            return None, 'Einzelblock-ID fehlt'
        blocks.setdefault(bid, []).append(row)
    if len(blocks) != 2 or any(len(rows) != slots for rows in blocks.values()):
        return None, f'Erwartet werden zwei Einzelblöcke mit jeweils {slots} Einzeln'

    result = []
    fallback = False
    block_rows = list(blocks.values())
    # Prefer explicit block order when the API supplies it.
    for field in ('number', 'sortOrder', 'order'):
        labels = [rows[0].get('matchReportBlock', {}).get(field) for rows in block_rows]
        if all(isinstance(v, int) and not isinstance(v, bool) for v in labels) and len(set(labels)) == len(labels):
            block_rows.sort(key=lambda rows: rows[0]['matchReportBlock'][field])
            break
    for rows in block_rows:
        ordered = None
        for field in ('number', 'matchNumber', 'position', 'sortOrder', 'order'):
            values = [r.get(field) for r in rows]
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in values):
                continue
            if len(set(values)) != slots:
                continue
            ascending = sorted(values)
            if ascending != list(range(ascending[0], ascending[0] + slots)):
                continue
            ordered = sorted(rows, key=lambda r: r[field])
            break
        if ordered is None:
            ordered = rows
            fallback = True
        result.append(ordered)
    return result, ('API-Reihenfolge verwendet, da keine eindeutige Positionsnummer vorliegt'
                    if fallback else None)


def opponent_positions(snapshot, tid, cutoff=None, slots=8, half_life=5, prior=0.5):
    """Historical positions for players on team tid, in both 8-single blocks.

    position_probabilities: P(position | player is selected for a single block).
    slot_probabilities: heuristic P(player | occupied position), normalized over
    all eligible players with usable history; not a joint lineup prediction.

    Older team matches are exponentially downweighted (half_life in matches).
    Return probability None when the player has no reliably assigned position.
    """
    if slots != 8:
        raise ValueError('Diese Liga-Auswertung erwartet genau 8 Einzelpositionen.')
    if half_life <= 0 or prior < 0:
        raise ValueError('half_life muss positiv, prior nicht negativ sein.')
    cutoff = cutoff or datetime.now(timezone.utc)
    players, gaps = team_players(snapshot, tid, cutoff=cutoff)
    by_name = defaultdict(list)
    for player in players:
        by_name[norm(player['name'])].append(player)
    history = sorted((m for m in matches(snapshot)
                      if side(m, tid) and m.get('statusCd') == 'FINISH'
                      and date(m.get('datePlanned')) and date(m['datePlanned']) < cutoff
                      and (not date(m.get('endDate')) or date(m['endDate']) < cutoff)
                      and not m.get('byeHome') and not m.get('byeAway')),
                     key=lambda m: date(m['datePlanned']))
    counts = {p['id']: [0] * slots for p in players}
    weighted = {p['id']: [0.] * slots for p in players}
    per_block = {p['id']: [[0] * slots for _ in range(2)] for p in players}
    position_history = {p['id']: [] for p in players}
    valid_matches = 0
    for match_index, match in enumerate(history):
        report = snapshot['reports'].get(str(match['id']))
        structure = match.get('phase', {}).get('matchReportStructure', '8xEZ;4xDP;8xEZ')
        expected = sum(int(n) for n in re.findall(r'(\d+)x[A-Z]+', structure))
        if not complete_report(report, expected):
            gaps.append(f"Spiel {match['id']}: kein vollständiger Bericht für Positionsanalyse")
            continue
        blocks, note = _single_blocks(report, slots)
        if blocks is None:
            gaps.append(f"Spiel {match['id']}: {note}")
            continue
        if note:
            gaps.append(f"Spiel {match['id']}: {note}")
        key = side(match, tid)
        event = []
        ambiguous = False
        for block_index, rows in enumerate(blocks):
            for pos, row in enumerate(rows, 1):
                candidates = by_name[norm(row[key].get('displayName', ''))]
                if len(candidates) != 1:
                    ambiguous = True
                    gaps.append(f"Spiel {match['id']}: Spielername in Einzel nicht eindeutig: "
                                + row[key].get('displayName', ''))
                    break
                event.append((candidates[0]['id'], block_index, pos))
            if ambiguous:
                break
        if ambiguous:
            continue  # Never partially count a match with unresolved identities
        age = len(history) - 1 - match_index
        weight = 0.5 ** (age / half_life)
        valid_matches += 1
        for pid, block_index, pos in event:
            counts[pid][pos - 1] += 1
            weighted[pid][pos - 1] += weight
            per_block[pid][block_index][pos - 1] += 1
            position_history[pid].append(dict(match_id=match['id'], date=match['datePlanned'],
                                              block=block_index + 1, position=pos))

    output = []
    for player in players:
        pid = player['id']
        n = sum(counts[pid])
        effective = sum(weighted[pid])
        if n:
            denom = effective + slots * prior
            conditional = [(v + prior) / denom for v in weighted[pid]] if denom else None
            most = max(range(slots), key=lambda i: (weighted[pid][i], -i)) + 1
        else:
            conditional, most = None, None
        output.append(dict(id=pid, name=player['name'], active=player['active'],
                           attendance=player['attendance'], single_appearances=n,
                           observed_positions=counts[pid],
                           position_probabilities=conditional, most_likely_position=most,
                           blocks=per_block[pid], history=position_history[pid],
                           games=player['games'], wins=player['wins'], strength=player['strength']))

    # Heuristic position probability: attendance prior times conditional slot distribution.
    # Exclude players not currently in the squad. No prediction for zero-history players.
    for index in range(slots):
        scores = [(p['attendance']['p'] or 0) * p['position_probabilities'][index]
                  if p['active'] and p['position_probabilities'] is not None else 0.
                  for p in output]
        denominator = sum(scores)
        for p, score in zip(output, scores):
            p.setdefault('slot_probabilities', []).append(score / denominator if denominator else None)

    slot_favorites = []
    for index in range(slots):
        ranked = sorted((dict(id=p['id'], name=p['name'], probability=p['slot_probabilities'][index])
                         for p in output if p['slot_probabilities'][index] is not None),
                        key=lambda p: -p['probability'])
        slot_favorites.append(dict(position=index+1, candidates=ranked))
    output.sort(key=lambda p: (not p['active'], -(p['attendance']['p'] or 0), p['name']))
    return dict(team_id=tid, matches_used=valid_matches, position_count=slots,
                explanation={'position_probabilities': 'P(Position | Einzeleinsatz im Block), geglättet und nach Aktualität gewichtet',
                             'slot_probabilities': 'heuristischer Anteil pro Position unter aktiven Spielern mit Historie',
                             'attendance': 'geschätzte Teilnahmechance anhand vollständiger Mannschaftsspiele'},
                players=output, slot_favorites=slot_favorites,
                gaps=list(dict.fromkeys(gaps)))


def next_opponent_positions(snapshot, own_team_id, cutoff=None):
    """Find the next opposing team and forecast its slots 1..8."""
    upcoming = next_match(snapshot, own_team_id, now=cutoff)
    if upcoming is None:
        return None
    own_side = side(upcoming, own_team_id)
    opponent = upcoming['participantGuest' if own_side == 'participantHome' else 'participantHome']
    result = opponent_positions(snapshot, opponent['id'], cutoff=cutoff)
    result['fixture'] = dict(match_id=upcoming['id'], date=upcoming.get('datePlanned'),
                             opponent=opponent.get('displayName'), home=own_side == 'participantHome')
    return result


if __name__ == '__main__':
    import argparse
    import json
    from pathlib import Path
    parser = argparse.ArgumentParser(description='3K-Darts Gegnerpositionen und Auftrittsprognose')
    parser.add_argument('snapshot', type=Path, help='Pfad zu snapshot.json')
    parser.add_argument('--team-id', required=True, type=int, help='Eigene Teilnehmer-ID für das nächste Spiel')
    parser.add_argument('--output', type=Path, help='Ergebnis als JSON speichern')
    args = parser.parse_args()
    from api import load
    result = next_opponent_positions(load(args.snapshot), args.team_id)
    if result is None:
        parser.error('Kein zukünftiges Spiel für diese Mannschaft in diesem Snapshot gefunden.')
    serialized = json.dumps(result, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding='utf-8')
    else:
        print(serialized)
