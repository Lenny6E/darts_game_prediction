"""Prepare a self-contained GitHub Pages artifact; no third-party packages."""
import argparse
import json
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from dartsliga import api, analysis as az


def pick(value, keys):
    return {key: value[key] for key in keys if key in value}


def public_data(snapshot):
    """Explicit allowlists: no addresses, contacts, usernames or pass numbers."""
    cutoff = min(az.date(snapshot['fetched_at']), datetime.now(timezone.utc))
    result = dict(schema=1, event_id=1570, default_team=175057,
                  as_of=snapshot['fetched_at'], calculated_at=cutoff.isoformat(),
                  event=pick(snapshot['event']['event'], ['id', 'name', 'nameShort']),
                  season=snapshot['event']['event'].get('saison', {}).get('name'),
                  errors=snapshot.get('errors', []), sources=snapshot.get('sources', []),
                  schedule_complete=all(r is not None for r in snapshot['rounds'].values()),
                  teams=[], matches=[], standings=[], performances=[], results=[], statistics=[])
    for team in snapshot['participants']:
        players, gaps = az.team_players(snapshot, team['id'], cutoff)
        public = []
        for player in players:
            row = pick(player, ['id', 'name', 'games', 'wins', 'legs', 'lost_legs', 'darts',
                'score', 'history', 'observations', 'attendance', 'average', 'strength', 'active'])
            row['registered_from'] = player['roster'].get('dateFrom')
            row['registered_to'] = player['roster'].get('dateTo')
            public.append(row)
        result['teams'].append(dict(id=team['id'], name=team['displayName'],
                                    players=public, gaps=gaps))
    for match in az.matches(snapshot):
        home, away = match.get('participantHome', {}), match.get('participantGuest', {})
        result['matches'].append(dict(id=match['id'], home=home.get('id'), away=away.get('id'),
            home_name=home.get('displayName', 'unbekannt'), away_name=away.get('displayName', 'unbekannt'),
            date=match.get('datePlanned'), end_date=match.get('endDate'), status=match.get('statusCd'),
            sets_home=match.get('setsHome'), sets_away=match.get('setsAway'),
            legs_home=match.get('legsHome'), legs_away=match.get('legsAway'),
            bye=bool(match.get('byeHome') or match.get('byeAway')),
            report_complete=az.complete_report(snapshot['reports'].get(str(match['id'])))))
    entries = (snapshot.get('table') or {}).get('tableEntries', [])
    if entries and 'tableEntries' in entries[0]:
        entries = entries[0]['tableEntries']
    result['standings'] = [pick(e, ['participantId', 'participantName', 'placement', 'matchCount',
        'win', 'lost', 'tie', 'points1', 'points2', 'sets1', 'sets2', 'legs1', 'legs2']) for e in entries]
    for player in (snapshot.get('results') or {}).get('playerResults', []):
        row = pick(player, ['displayName', 'place', 'placement'])
        row['member_id'] = player.get('member', {}).get('id')
        row['team_name'] = player.get('team', {}).get('name')
        for key in ['singleResult', 'doubleResult', 'totalResult']:
            row[key] = pick(player.get(key, {}), ['matchCount', 'matchWon', 'matchLost', 'legs1', 'legs2', 'matchDiff', 'legsDiff'])
        result['results'].append(row)
    for player in snapshot.get('statistics') or []:
        # Statistics contain many legitimate counters; preserve numeric counters only.
        row = {k: v for k, v in player.items() if type(v) in (int, float, bool) and k != 'participantId'}
        row.update(name=player.get('displayName'), team_name=player.get('team', {}).get('name'))
        result['statistics'].append(row)
    for catalog in (snapshot.get('performance') or {}).get('performanceCatalog', []):
        for entry in catalog.get('playerPerformances', []):
            result['performances'].append(dict(category=catalog.get('name', catalog.get('performanceTypeCd')),
                name=entry.get('participant', {}).get('displayName') or ', '.join(
                    p.get('player', {}).get('displayName', '?') for p in entry.get('performancePlayers', [])),
                value=entry.get('value'), count=entry.get('count')))
    return result


def validate(data):
    if data.get('schema') != 1 or data.get('event_id') != 1570:
        raise ValueError('Falsches Event oder Datenformat.')
    if not any(t['id'] == 175057 for t in data['teams']):
        raise ValueError('RSV Detmold-Klüt fehlt. Keine Veröffentlichung falscher Ligadaten.')
    if az.date(data.get('as_of')) is None:
        raise ValueError('Datenstand fehlt.')


def build(output, snapshot=None, refresh=False, write_data=False):
    if refresh:
        with tempfile.TemporaryDirectory() as tmp:
            source = api.download(tmp, print)
            if source['errors']:
                raise RuntimeError('Aktualisierung unvollständig; bisherige Veröffentlichung bleibt bestehen: '
                                   + '\n'.join(source['errors']))
            data = public_data(source)
    elif snapshot:
        data = public_data(api.load(snapshot))
    else:
        data = json.loads((ROOT/'site/data/league.json').read_text(encoding='utf-8'))
    validate(data)
    output = Path(output).resolve()
    # Never allow build output to overwrite the source tree or project root.
    if output == ROOT or output == ROOT/'site' or ROOT.is_relative_to(output) or output.is_relative_to(ROOT/'site'):
        raise ValueError('Ausgabe muss ein eigener Build-Ordner sein, z. B. dist/.')
    if write_data:
        api.atomic_json(ROOT/'site/data/league.json', data)
    shutil.copytree(ROOT/'site', output, dirs_exist_ok=True)
    api.atomic_json(output/'data/league.json', data)
    (output/'.nojekyll').touch()
    print(f'Fertig: {output}; Datenstand {data["as_of"]}; {len(data["teams"])} Teams')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', action='store_true', help='Neue Daten vom Portal laden; bei Lücken abbrechen')
    parser.add_argument('--snapshot', type=Path, help='Lokalen Desktop-Snapshot umwandeln')
    parser.add_argument('--output', type=Path, default=ROOT/'dist')
    parser.add_argument('--write-data', action='store_true', help='Erfolgreichen Datenstand auch in site/data speichern')
    args = parser.parse_args()
    if args.refresh and args.snapshot:
        parser.error('--refresh und --snapshot schließen sich aus')
    build(args.output, args.snapshot, args.refresh, args.write_data)
