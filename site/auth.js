// Client-side access hurdle only: GitHub Pages assets remain directly accessible.
export async function verifyPassword(password, expectedHash, cryptoApi = globalThis.crypto) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw new Error('Passwort-Hash ist nicht konfiguriert.');
  if (!cryptoApi?.subtle) throw new Error('Bitte die Seite über HTTPS oder localhost öffnen.');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(password));
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return actual === expectedHash;
}

export function setupGate(doc, cryptoApi = globalThis.crypto, loadApp = () => import('./app.js')) {
  const gate = doc.querySelector('#password-gate');
  const app = doc.querySelector('#protected-app');
  const form = doc.querySelector('#password-form');
  const input = doc.querySelector('#team-password');
  const submit = doc.querySelector('#password-submit');
  const error = doc.querySelector('#password-error');
  const hash = doc.querySelector('meta[name="access-password-sha256"]').content;
  let loaded = false, checking = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (checking) return;
    checking = true;
    submit.disabled = true;
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    try {
      if (!await verifyPassword(input.value, hash, cryptoApi)) {
        error.textContent = 'Das Passwort stimmt nicht. Bitte erneut versuchen.';
        input.setAttribute('aria-invalid', 'true');
        input.value = '';
        input.focus();
        return;
      }
      // Load the application and its sport data only after successful entry.
      if (!loaded) { await loadApp(); loaded = true; }
      input.value = '';
      gate.hidden = true;
      app.hidden = false;
      doc.querySelector('#main').focus();
    } catch (exc) {
      error.textContent = exc.message || 'Das Tool konnte nicht geladen werden. Bitte die Seite neu laden.';
    } finally {
      checking = false;
      submit.disabled = false;
    }
  });
  doc.querySelector('#logout').addEventListener('click', () => {
    app.hidden = true;
    gate.hidden = false;
    input.value = '';
    input.removeAttribute('aria-invalid');
    error.textContent = '';
    input.focus();
  });
}

if (typeof document !== 'undefined') setupGate(document);
