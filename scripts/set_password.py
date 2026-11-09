"""Store only a SHA-256 hash in site/index.html; never save the password."""
import getpass
import hashlib
import re
from pathlib import Path


def set_hash(password, path):
    if not password:
        raise ValueError('Passwort darf nicht leer sein.')
    digest = hashlib.sha256(password.encode('utf-8')).hexdigest()
    text = Path(path).read_text(encoding='utf-8')
    text, count = re.subn(r'(<meta name="access-password-sha256" content=")[^"]*(">)',
                         lambda m: m[1] + digest + m[2], text)
    if count != 1:
        raise ValueError('Genau ein Passwort-Metafeld in index.html erwartet.')
    Path(path).write_text(text, encoding='utf-8')
    return digest


if __name__ == '__main__':
    first = getpass.getpass('Neues Team-Passwort: ')
    if first != getpass.getpass('Passwort wiederholen: '):
        raise SystemExit('Passwörter stimmen nicht überein. Keine Änderung.')
    set_hash(first, Path(__file__).resolve().parents[1]/'site/index.html')
    print('SHA-256-Hash aktualisiert. Jetzt python scripts/build.py ausführen und site/index.html übernehmen.')
