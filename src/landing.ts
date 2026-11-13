import type { AppEnv } from './types';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

export function isLandingRequest(request: Request, url: URL): boolean {
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  if (request.method !== 'GET' && request.method !== 'POST') return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

async function passwordMatches(submitted: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(submitted)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #121212; color: #e8e8e8;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: min(680px, 100%); }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: .01em; }
  p.sub { margin: 0 0 24px; color: #8a8a8a; font-size: 13px; }
  dl { display: grid; gap: 10px; margin: 0; }
  .row {
    display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; gap: 12px;
    align-items: center; padding: 12px 14px; border: 1px solid #2a2a2a;
    border-radius: 10px; background: #1a1a1a;
  }
  .row.stack { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
  .row.stack dt { grid-column: 1 / -1; margin-bottom: 8px; }
  dt { color: #8a8a8a; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  dd {
    margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .row.stack dd { white-space: normal; overflow-wrap: anywhere; max-height: 7.5em; overflow-y: auto; }
  button {
    border: 1px solid #333; border-radius: 7px; background: #232323; color: #cfcfcf;
    font: inherit; font-size: 12px; padding: 6px 10px; cursor: pointer;
  }
  button:hover { background: #2b2b2b; color: #fff; }
  button:active { transform: translateY(1px); }
  form { display: grid; gap: 12px; }
  input[type=password] {
    width: 100%; padding: 11px 12px; border: 1px solid #333; border-radius: 9px;
    background: #1a1a1a; color: #e8e8e8; font: inherit;
  }
  input[type=password]:focus { outline: 2px solid #5b5bd6; outline-offset: 1px; border-color: #5b5bd6; }
  form button { padding: 11px 12px; font-size: 14px; background: #5b5bd6; border-color: #5b5bd6; color: #fff; }
  form button:hover { background: #6a6ae0; }
  .error { margin: 0 0 12px; color: #ff8a8a; font-size: 13px; }
</style>
<main>${body}</main>
</html>`;
}

function gate(origin: string, error: string): Response {
  const html = page(
    origin.replace(/^https?:\/\//, ''),
    `<h1>LiveSync</h1>
  <p class="sub">Enter the password to see the setup details.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/">
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
    <button type="submit">Continue</button>
  </form>`,
  );
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

function row(id: string, label: string, value: string, stacked = false): string {
  return `<div class="row${stacked ? ' stack' : ''}"><dt>${label}</dt><dd id="${id}">${escapeHtml(value)}</dd><button data-copy="${id}">Copy</button></div>`;
}

function setup(origin: string, env: AppEnv): Response {
  const setupUri = env.SETUP_URI;
  const setupPassphrase = env.SETUP_URI_PASSPHRASE;
  const rows = setupUri && setupPassphrase
    ? row('v-uri', 'Setup URI', setupUri, true) + row('v-pass', 'Passphrase', setupPassphrase)
    : [
        row('v-url', 'URL', origin, true),
        row('v-db', 'Database', env.BACKUP_DATABASE || 'vault'),
        row('v-user', 'Username', env.COUCHDB_USERNAME),
        row('v-pass', 'Password', env.COUCHDB_PASSWORD),
      ].join('');
  const html = page(
    origin.replace(/^https?:\/\//, ''),
    `<h1>LiveSync</h1>
  <p class="sub">Setup</p>
  <dl>${rows}</dl>
<script>
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const value = document.getElementById(button.dataset.copy).textContent;
    const done = () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(value).then(done, () => {});
  });
</script>`,
  );
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * Connection material for the people this deployment is shared with. Not part of
 * the CouchDB surface: browsers ask for text/html, LiveSync clients never do.
 *
 * The setup details are never served without a password; there is no session or
 * cookie, so every visit has to enter it again. PAGE_PASSWORD overrides the
 * gate, and COUCHDB_PASSWORD is the fallback so a deployment needs only the one
 * secret. If neither exists the page fails closed.
 */
export async function landingPage(request: Request, env: AppEnv): Promise<Response> {
  const origin = new URL(request.url).origin;
  const expected = env.PAGE_PASSWORD || env.COUCHDB_PASSWORD;
  if (!expected) {
    return new Response('Not configured.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  if (request.method === 'GET') return gate(origin, '');
  const submitted = new URLSearchParams(await request.text()).get('password') ?? '';
  if (!(await passwordMatches(submitted, expected))) return gate(origin, 'Wrong password.');
  return setup(origin, env);
}
