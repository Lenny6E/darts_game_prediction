"""Read-only portal adapter. Preserve raw responses and provenance."""
import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = 'https://backend-ddv.3k-darts.com/2k-backend-ddv/api/v1/frontend/'
PORTAL = 'https://portal.3k-darts.com/frontend/events/10/event/1570'
PAGES = ['participants', 'phase/2293/group/38960', 'table', 'performances',
         'statistics/statistics', 'statistics/player/results']


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


class PortalError(RuntimeError):
    pass


class Client:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.sources = []

    def get(self, path):
        url = BASE + path
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={
                    'Origin': 'https://portal.3k-darts.com',
                    'Referer': 'https://portal.3k-darts.com/',
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json', 'Accept-Language': 'de'})
                with urllib.request.urlopen(req, timeout=25) as response:
                    raw = response.read(25_000_001)
                    if len(raw) > 25_000_000:
                        raise PortalError('Antwort zu groß: ' + url)
                data = json.loads(raw)
                stamp = datetime.now(timezone.utc).isoformat()
                digest = hashlib.sha256(raw).hexdigest()
                self.directory.mkdir(parents=True, exist_ok=True)
                (self.directory / (digest + '.json')).write_bytes(raw)
                self.sources.append(dict(url=url, fetched_at=stamp, sha256=digest))
                time.sleep(0.5)
                return data
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504):
                    raise PortalError(f'HTTP {exc.code}: {url}') from exc
                error = exc
            except (OSError, ValueError) as exc:
                error = exc
            time.sleep(0.5 * (2 ** attempt))
        raise PortalError(f'{url}: {error}')


def download(directory, progress=lambda text: None):
    """Required core must succeed; optional failures remain explicit gaps."""
    directory = Path(directory)
    client = Client(directory / 'raw')
    result = dict(schema=1, event_id=1570, errors=[], teams={}, rounds={}, reports={})

    def fetch(key, path, required=False):
        progress(path)
        try:
            value = client.get(path)
            if not isinstance(value, (dict, list)):
                raise PortalError('Unerwartetes JSON-Schema: ' + path)
            return value
        except PortalError as exc:
            if required:
                raise
            result['errors'].append(f'{key}: {exc}')
            return None

    result['event'] = fetch('event', 'event/1570', True)
    if result['event'].get('event', {}).get('id') != 1570:
        raise PortalError('Event-Identität stimmt nicht.')
    result['participants'] = fetch('participants', 'event/1570/participant', True)
    if not isinstance(result['participants'], list):
        raise PortalError('Teilnehmerliste fehlt oder Schema geändert.')
    for key, path in [('table', 'phase/0/round/0/table'), ('performance', 'performance'),
                      ('statistics', 'statistics'), ('results', 'player/results')]:
        result[key] = fetch(key, 'event/1570/' + path)
    result['phase'] = fetch('phase', 'event/1570/phase/2293', True)
    if not isinstance(result['phase'].get('rounds'), list):
        raise PortalError('Runden fehlen oder Schema geändert.')
    for team in result['participants']:
        tid = team['id']
        result['teams'][str(tid)] = fetch(str(tid), f'participant/{tid}')
    seen = set()
    for rnd in result['phase']['rounds']:
        rid = rnd['id']
        detail = fetch(str(rid), f'event/1570/phase/2293/round/{rid}')
        result['rounds'][str(rid)] = detail
        for match in (detail or {}).get('matches', []):
            mid = match['id']
            if mid in seen or match.get('statusCd') != 'FINISH':
                continue
            seen.add(mid)
            result['reports'][str(mid)] = fetch(str(mid), f'event/1570/match/{mid}/report')
    result['fetched_at'] = datetime.now(timezone.utc).isoformat()
    result['sources'] = client.sources
    atomic_json(directory / 'snapshot.json', result)
    return result


def load(path):
    value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if value.get('schema') != 1 or value.get('event_id') != 1570:
        raise ValueError('Kein unterstützter Event-1570-Snapshot.')
    for key, typ in [('event', dict), ('participants', list), ('rounds', dict), ('reports', dict), ('teams', dict)]:
        if not isinstance(value.get(key), typ):
            raise ValueError('Snapshot-Feld fehlt/ungültig: ' + key)
    if value['event'].get('event', {}).get('id') != 1570:
        raise ValueError('Event-Identität im Snapshot stimmt nicht.')
    return value
