"""Check packaged data, relative paths and required static assets."""
import json
import re
import sys
from pathlib import Path

def check(directory):
    directory = Path(directory)
    for filename in ['index.html', 'auth.js', 'app.js', 'model.js', 'styles.css', 'icon.svg', '.nojekyll', 'data/league.json']:
        if not (directory/filename).is_file():
            raise ValueError('Datei fehlt: '+filename)
    html = (directory/'index.html').read_text(encoding='utf-8')
    if not re.search(r'<meta name="access-password-sha256" content="[a-f0-9]{64}">', html):
        raise ValueError('Passwort-Hash fehlt oder ist ungültig.')
    for relative in re.findall(r'(?:src|href)="(\./[^"#]+)"', html):
        if not (directory/relative).is_file():
            raise ValueError('Asset fehlt: '+relative)
    if re.search(r'(?:src|href)="/(?!/)', html):
        raise ValueError('Absolute Asset-Pfade funktionieren nicht in Pages-Projekt-Repositories.')
    data=json.loads((directory/'data/league.json').read_text(encoding='utf-8'))
    if data['event_id'] != 1570 or not any(t['id']==175057 for t in data['teams']):
        raise ValueError('RSV / Event fehlt')
    forbidden={'email','phone','mobile','locationStreet','passNr','passNrGlobal','username','firstname','genderCd','contactPerson'}
    def walk(value):
        if isinstance(value,dict):
            if forbidden.intersection(value):
                raise ValueError('Nicht freigegebene Kontakt-/Stammdaten im Webexport')
            for item in value.values():walk(item)
        elif isinstance(value,list):
            for item in value:walk(item)
    walk(data)
    if not data['sources'] or not data['as_of']:
        raise ValueError('Quellen oder Zeitpunkt fehlen')
    print(f'Pages-Artefakt OK: {len(data["teams"])} Teams, {len(data["matches"])} Begegnungen.')

if __name__=='__main__':
    check(sys.argv[1] if len(sys.argv)>1 else 'dist')
