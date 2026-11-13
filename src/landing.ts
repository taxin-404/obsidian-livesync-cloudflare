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
  if (request.method !== 'GET') return false;
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * Connection details for the people this deployment is shared with. Not part of
 * the CouchDB surface: browsers ask for text/html, LiveSync clients never do.
 */
export function landingPage(request: Request, env: AppEnv): Response {
  const origin = new URL(request.url).origin;
  const database = escapeHtml(env.BACKUP_DATABASE || 'vault');
  const username = escapeHtml(env.COUCHDB_USERNAME);
  const password = escapeHtml(env.COUCHDB_PASSWORD);
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(origin.replace(/^https?:\/\//, ''))}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #121212; color: #e8e8e8;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: min(560px, 100%); }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: .01em; }
  p.sub { margin: 0 0 24px; color: #8a8a8a; font-size: 13px; }
  dl { display: grid; gap: 10px; margin: 0; }
  .row {
    display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; gap: 12px;
    align-items: center; padding: 12px 14px; border: 1px solid #2a2a2a;
    border-radius: 10px; background: #1a1a1a;
  }
  dt { color: #8a8a8a; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  dd {
    margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  button {
    border: 1px solid #333; border-radius: 7px; background: #232323; color: #cfcfcf;
    font: inherit; font-size: 12px; padding: 6px 10px; cursor: pointer;
  }
  button:hover { background: #2b2b2b; color: #fff; }
  button:active { transform: translateY(1px); }
</style>
<main>
  <h1>LiveSync</h1>
  <p class="sub">Connection details</p>
  <dl>
    <div class="row"><dt>URL</dt><dd id="v-url">${escapeHtml(origin)}</dd><button data-copy="v-url">Copy</button></div>
    <div class="row"><dt>Database</dt><dd id="v-db">${database}</dd><button data-copy="v-db">Copy</button></div>
    <div class="row"><dt>Username</dt><dd id="v-user">${username}</dd><button data-copy="v-user">Copy</button></div>
    <div class="row"><dt>Password</dt><dd id="v-pass">${password}</dd><button data-copy="v-pass">Copy</button></div>
  </dl>
</main>
<script>
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const value = document.getElementById(button.dataset.copy).textContent;
    const done = () => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(value).then(done, () => {});
  });
</script>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}
