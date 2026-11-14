import type { AppEnv } from './types';

export const SETUP_TICKET_MAX_AGE_MS = 60_000;
const SETUP_TICKET_VERSION = 'v1';
const SETUP_TICKET_CONTEXT = 'livesync-page-ticket:v1:';
const SETUP_TICKET_SIGNATURE_BYTES = 32;

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

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function ticketKey(password: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(SETUP_TICKET_CONTEXT + password));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSetupTicket(password: string, now = Date.now()): Promise<string> {
  const expiresAt = now + SETUP_TICKET_MAX_AGE_MS;
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${SETUP_TICKET_VERSION}.${expiresAt}.${nonce}`;
  const key = await ticketKey(password);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySetupTicket(ticket: string, password: string, now = Date.now()): Promise<boolean> {
  const parts = ticket.split('.');
  if (parts.length !== 4) return false;
  const [version, expiresAtText, nonce, signatureText] = parts;
  if (version !== SETUP_TICKET_VERSION) return false;
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt)) return false;
  if (expiresAt <= now || expiresAt > now + SETUP_TICKET_MAX_AGE_MS) return false;
  const signature = base64UrlDecode(signatureText);
  if (!signature || signature.byteLength !== SETUP_TICKET_SIGNATURE_BYTES) return false;
  const key = await ticketKey(password);
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(`${version}.${expiresAt}.${nonce}`),
  );
}

const HTTP_SETUP_COOKIE = 'livesync_setup';
const HTTPS_SETUP_COOKIE = '__Host-livesync_setup';

function cookieName(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? HTTPS_SETUP_COOKIE : HTTP_SETUP_COOKIE;
}

function serializeCookie(request: Request, value: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const expires = maxAgeSeconds === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '';
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${expires}${secure}`;
}

function readSetupCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const name = cookieName(request);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function pageHeaders(
  { varyCookie = false, clearCookie }: { varyCookie?: boolean; clearCookie?: string } = {},
): Headers {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (varyCookie) headers.set('vary', 'Cookie');
  if (clearCookie) headers.append('set-cookie', clearCookie);
  return headers;
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

function gate(origin: string, error: string, clearCookie?: string): Response {
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
    headers: pageHeaders({ clearCookie }),
  });
}

function row(id: string, label: string, value: string, stacked = false): string {
  return `<div class="row${stacked ? ' stack' : ''}"><dt>${label}</dt><dd id="${id}">${escapeHtml(value)}</dd><button data-copy="${id}">Copy</button></div>`;
}

function setup(origin: string, env: AppEnv, clearCookie?: string): Response {
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
</script>
<script>
  addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
</script>`,
  );
  return new Response(html, {
    headers: pageHeaders({ varyCookie: true, clearCookie }),
  });
}

/**
 * Connection material for the people this deployment is shared with. Not part of
 * the CouchDB surface: browsers ask for text/html, LiveSync clients never do.
 *
 * The setup details are never served without a password. A correct POST sets a
 * short-lived signed ticket cookie and redirects; the GET that follows serves the
 * details once and clears the cookie, so refreshing, reopening, or coming back
 * asks again. PAGE_PASSWORD overrides the gate, and COUCHDB_PASSWORD is the
 * fallback so a deployment needs only the one secret. If neither exists the page
 * fails closed.
 */
export async function landingPage(request: Request, env: AppEnv): Promise<Response> {
  const origin = new URL(request.url).origin;
  const expected = env.PAGE_PASSWORD || env.COUCHDB_PASSWORD;
  if (!expected) {
    return new Response('Not configured.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  if (request.method === 'GET') {
    const ticket = readSetupCookie(request);
    if (ticket && await verifySetupTicket(ticket, expected)) {
      return setup(origin, env, serializeCookie(request, '', 0));
    }
    return gate(origin, '', ticket ? serializeCookie(request, '', 0) : undefined);
  }
  const submitted = new URLSearchParams(await request.text()).get('password') ?? '';
  if (!(await passwordMatches(submitted, expected))) {
    return gate(origin, 'Wrong password.', readSetupCookie(request) ? serializeCookie(request, '', 0) : undefined);
  }
  const ticket = await createSetupTicket(expected);
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': serializeCookie(request, ticket, SETUP_TICKET_MAX_AGE_MS / 1000),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
