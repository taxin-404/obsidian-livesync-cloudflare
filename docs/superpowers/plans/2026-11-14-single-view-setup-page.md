# Single-view Setup Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require the page password again on refresh or close by serving the setup details from a short-lived, signed ticket cookie that is cleared after one view.

**Architecture:** Add signed-ticket helpers and cookie helpers to `src/landing.ts`. A correct `POST` returns `303` with a 60-second HttpOnly ticket cookie; the following `GET` verifies the ticket, serves the setup HTML, and clears the cookie in the same response. Add a back/forward-cache reload guard and small page-hardening headers.

**Tech Stack:** TypeScript, Cloudflare Workers, Web Crypto, Vitest with the Cloudflare/workerd plugin.

**Spec:** `docs/superpowers/specs/2026-11-14-single-view-setup-page-design.md`

## Global Constraints

- Keep the Worker on the Cloudflare free tier; add no bindings, secrets, cron jobs, or paid features.
- Do not change the server password, setup URI, E2EE settings, or any Obsidian vault.
- Never print or commit a real secret. Tests use the existing test password `test-password`.
- Keep the page usable without JavaScript for viewing the setup details; the existing copy buttons may still use JavaScript.
- Preserve the current gate behavior: a wrong password returns `401` and exposes no setup details; a missing page password returns `503`.
- Keep the existing `no-store`, `no-referrer`, and `noindex` headers.

## Review Focus

- A malformed, duplicated, expired, or tampered cookie must show the gate, never crash or reveal setup details.
- A setup page restored from the browser's back/forward cache must reload back to the gate.
- The page must still work on plain HTTP in local `wrangler dev` (cookie without `Secure`, name `livesync_setup`).
- A page-password change must invalidate tickets signed with the old password.
- The setup page must not be reachable by refreshing the redirected `GET` after its ticket has been cleared.

---

### Task 1: Signed setup ticket

**Files:**
- Modify: `src/landing.ts`
- Create: `test/landing.test.ts`
- Modify: `package.json` (add `test/landing.test.ts` to the primary `test` command)

**Interfaces:**
- Consumes: existing `AppEnv` type only; no new environment variables.
- Produces:
  - `export const SETUP_TICKET_MAX_AGE_MS = 60_000`
  - `export async function createSetupTicket(password: string, now = Date.now()): Promise<string>`
  - `export async function verifySetupTicket(ticket: string, password: string, now = Date.now()): Promise<boolean>`

- [ ] **Step 1: Write the failing ticket tests**

Create `test/landing.test.ts` with this content:

```ts
import { describe, expect, it } from 'vitest';
import { createSetupTicket, verifySetupTicket } from '../src/landing';

const password = 'test-password';
const issuedAt = 1_800_000_000_000;

describe('setup ticket', () => {
  it('accepts a fresh ticket', async () => {
    const ticket = await createSetupTicket(password, issuedAt);
    await expect(verifySetupTicket(ticket, password, issuedAt + 59_000)).resolves.toBe(true);
  });

  it('rejects a ticket after its 60-second lifetime', async () => {
    const ticket = await createSetupTicket(password, issuedAt);
    await expect(verifySetupTicket(ticket, password, issuedAt + 60_001)).resolves.toBe(false);
  });

  it('rejects a ticket signed with another password', async () => {
    const ticket = await createSetupTicket(password, issuedAt);
    await expect(verifySetupTicket(ticket, 'different-password', issuedAt + 1)).resolves.toBe(false);
  });

  it('rejects a tampered ticket', async () => {
    const ticket = await createSetupTicket(password, issuedAt);
    const last = ticket.at(-1) === 'A' ? 'B' : 'A';
    await expect(verifySetupTicket(`${ticket.slice(0, -1)}${last}`, password, issuedAt + 1)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the ticket tests and confirm they fail**

Run: `npx vitest run test/landing.test.ts`

Expected: FAIL because `createSetupTicket` and `verifySetupTicket` are not exported yet.

- [ ] **Step 3: Implement the ticket helpers in `src/landing.ts`**

Add constants near the top:

```ts
export const SETUP_TICKET_MAX_AGE_MS = 60_000;
const SETUP_TICKET_VERSION = 'v1';
const SETUP_TICKET_CONTEXT = 'livesync-page-ticket:v1:';
```

Add private helpers:
- `base64UrlEncode(bytes: Uint8Array): string` using `btoa`, replacing `+` with `-`, `/` with `_`, and stripping `=`.
- `base64UrlDecode(value: string): Uint8Array | null` validating `^[A-Za-z0-9_-]+$`, restoring padding, and returning `null` on any `atob` failure.
- `ticketKey(password: string): Promise<CryptoKey>`: SHA-256 of `SETUP_TICKET_CONTEXT + password`, imported as an HMAC-SHA256 key with `sign` and `verify` usages.

Implement `createSetupTicket`:
- `expiresAt = now + SETUP_TICKET_MAX_AGE_MS`
- `nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))`
- `payload = `${SETUP_TICKET_VERSION}.${expiresAt}.${nonce}``
- Sign the UTF-8 payload with the HMAC key.
- Return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`.

Implement `verifySetupTicket`:
- Split on `.` and require exactly four parts.
- Require version `v1`, a safe-integer `expiresAt`, `expiresAt > now`, and `expiresAt <= now + SETUP_TICKET_MAX_AGE_MS`.
- Decode the signature; require exactly 32 bytes.
- Verify the HMAC over `v1.<expiresAt>.<nonce>` with the key derived from `password`; return the Web Crypto result.

- [ ] **Step 4: Add the focused test to the primary suite**

In `package.json`, add `test/landing.test.ts` to the first `vitest run` list in the `test` script, before `test/chunk-publication.test.ts`.

- [ ] **Step 5: Run the ticket tests and confirm they pass**

Run: `npx vitest run test/landing.test.ts`

Expected: PASS for all four tests.

- [ ] **Step 6: Commit**

```bash
git add src/landing.ts test/landing.test.ts package.json
git commit -m "Add signed setup view tickets"
```

---

### Task 2: Single-view landing flow and page hardening

**Files:**
- Modify: `src/landing.ts`
- Modify: `test/worker.test.ts`
- Modify: `test/landing.test.ts`
- Modify: `README.md:182-190`

**Interfaces:**
- Consumes: `SETUP_TICKET_MAX_AGE_MS`, `createSetupTicket`, `verifySetupTicket` from Task 1.
- Produces: the same `landingPage(request, env)` signature; no new public API other than the Task 1 exports.

- [ ] **Step 1: Update the integration test to require the new behavior**

Replace the body of the existing test in `test/worker.test.ts` named `requires the page password before showing the setup details` with assertions for:

```ts
const form = await SELF.fetch(new Request('https://pouch.test/', {
  headers: { accept: 'text/html,application/xhtml+xml' },
}));
expect(form.status).toBe(200);
expect(form.headers.get('x-robots-tag')).toContain('noindex');
expect(form.headers.get('x-frame-options')).toBe('DENY');
expect(form.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
const formHtml = await form.text();
expect(formHtml).toContain('name="password"');
expect(formHtml).not.toContain('obsidian://setuplivesync');

const wrong = await SELF.fetch(new Request('https://pouch.test/', {
  method: 'POST',
  redirect: 'manual',
  headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=nope',
}));
expect(wrong.status).toBe(401);
expect(await wrong.text()).not.toContain('obsidian://setuplivesync');

const ok = await SELF.fetch(new Request('https://pouch.test/', {
  method: 'POST',
  redirect: 'manual',
  headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=test-password',
}));
expect(ok.status).toBe(303);
expect(ok.headers.get('location')).toBe('/');
expect(ok.headers.get('cache-control')).toContain('no-store');
expect(await ok.text()).toBe('');

const setCookie = ok.headers.get('set-cookie') ?? '';
expect(setCookie).toContain('__Host-livesync_setup=');
expect(setCookie).toContain('Path=/');
expect(setCookie).toContain('HttpOnly');
expect(setCookie).toContain('SameSite=Strict');
expect(setCookie).toContain('Max-Age=60');
expect(setCookie).toContain('Secure');
expect(setCookie).not.toContain('Domain=');
const cookiePair = setCookie.split(';', 1)[0];

const setup = await SELF.fetch(new Request('https://pouch.test/', {
  headers: { accept: 'text/html', cookie: cookiePair },
}));
expect(setup.status).toBe(200);
expect(setup.headers.get('cache-control')).toContain('no-store');
expect((setup.headers.get('vary') ?? '').toLowerCase()).toContain('cookie');
const html = await setup.text();
expect(html).toContain('obsidian://setuplivesync?settings=test');
expect(html).toContain('test-uri-passphrase');
expect(html).toContain("addEventListener('pageshow'");
const clear = setup.headers.get('set-cookie') ?? '';
expect(clear).toContain('__Host-livesync_setup=');
expect(clear).toContain('Max-Age=0');

const afterClear = await SELF.fetch(new Request('https://pouch.test/', {
  headers: { accept: 'text/html' },
}));
expect(await afterClear.text()).toContain('name="password"');

const tampered = `${cookiePair.slice(0, -1)}${cookiePair.endsWith('A') ? 'B' : 'A'}`;
const tamperedPage = await SELF.fetch(new Request('https://pouch.test/', {
  headers: { accept: 'text/html', cookie: tampered },
}));
expect(await tamperedPage.text()).toContain('name="password"');
expect(tamperedPage.headers.get('set-cookie')).toContain('Max-Age=0');

const expiredTicket = await createSetupTicket('test-password', Date.now() - 61_000);
const expiredPage = await SELF.fetch(new Request('https://pouch.test/', {
  headers: { accept: 'text/html', cookie: `__Host-livesync_setup=${expiredTicket}` },
}));
expect(await expiredPage.text()).toContain('name="password"');
```

Import `createSetupTicket` at the top of `test/worker.test.ts`.

- [ ] **Step 2: Run the integration test and confirm it fails**

Run: `npx vitest run test/worker.test.ts -t "requires the page password"`

Expected: FAIL because the current handler returns `200` from the `POST` and sets no cookie.

- [ ] **Step 3: Add the cookie helpers and new `landingPage` flow**

In `src/landing.ts`:

- Add `const HTTP_SETUP_COOKIE = 'livesync_setup'` and `const HTTPS_SETUP_COOKIE = '__Host-livesync_setup'`.
- Add `cookieName(request: Request): string`: HTTPS uses `__Host-livesync_setup`, HTTP uses `livesync_setup`.
- Add `serializeCookie(request: Request, value: string, maxAgeSeconds: number): string`: `name=value; Path=/; HttpOnly; SameSite=Strict; Max-Age=<n>` plus `; Secure` on HTTPS and `; Expires=Thu, 01 Jan 1970 00:00:00 GMT` when `maxAgeSeconds === 0`.
- Add `readSetupCookie(request: Request): string | null`: parse the `cookie` header for the protocol-appropriate name; return `null` if absent.
- Add `pageHeaders(options: { varyCookie?: boolean; clearCookie?: string } = {}): Headers`: start with `cache-control: no-store`, `x-robots-tag: noindex, nofollow`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, and `content-security-policy: frame-ancestors 'none'; base-uri 'none'; form-action 'self'`; set `vary: Cookie` when requested; append `set-cookie` when `clearCookie` is provided.

Change `gate(origin, error, clearCookie?)` and `setup(origin, env, clearCookie?)` to use `pageHeaders({ clearCookie })`; `setup` also passes `varyCookie: true`.

Change `landingPage`:

```ts
const expected = env.PAGE_PASSWORD || env.COUCHDB_PASSWORD;
if (!expected) return new Response('Not configured.', { status: 503, headers: { 'cache-control': 'no-store' } });

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
```

- [ ] **Step 4: Add the back/forward-cache guard**

In the `setup` page body, add this before or after the existing copy script:

```html
<script>
  addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
</script>
```

- [ ] **Step 5: Add the HTTP and missing-password unit tests to `test/landing.test.ts`**

Add a `describe('landing page', ...)` block using direct calls to `landingPage` with a minimal env cast:

```ts
const env = { COUCHDB_PASSWORD: 'test-password' } as AppEnv;

const httpPost = await landingPage(new Request('http://localhost/', {
  method: 'POST',
  headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
  body: 'password=test-password',
}), env);
expect(httpPost.status).toBe(303);
const httpCookie = httpPost.headers.get('set-cookie') ?? '';
expect(httpCookie).toContain('livesync_setup=');
expect(httpCookie).not.toContain('__Host-');
expect(httpCookie).not.toContain('Secure');

const missing = await landingPage(new Request('https://pouch.test/', {
  headers: { accept: 'text/html' },
}), {} as AppEnv);
expect(missing.status).toBe(503);
```

Import `landingPage` and `AppEnv` in the test file.

- [ ] **Step 6: Update the README wording**

Replace:

> There is no session or cookie, so every visit asks again.

with:

> The details are shown once per password entry: a short-lived ticket cookie is
> cleared as soon as the page is served, so refreshing, reopening the tab, or
> visiting again asks for the password again.

- [ ] **Step 7: Run the focused tests and type check**

Run:

```bash
npx vitest run test/landing.test.ts test/worker.test.ts -t "page password|setup ticket|landing page"
npm run check:storage
```

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 8: Commit**

```bash
git add src/landing.ts test/landing.test.ts test/worker.test.ts README.md
git commit -m "Require the page password for each setup view"
```

---

### Task 3: Verify the whole change and deploy

**Files:**
- No source changes.

- [ ] **Step 1: Run the repository checks**

```bash
npm run types:check
npm run check
npm test
npm run dry-run
```

Expected: all commands exit 0. If a pre-existing unrelated failure appears, record it and do not deploy until the landing tests and dry-run are clean.

- [ ] **Step 2: Commit any remaining files and push**

```bash
git status --short
git push origin main
```

Expected: a clean status and a successful push. Workers Builds deploys the `live` Worker from `main`; if this repository's build is not automatic, run `npm run deploy` after confirming account access.

- [ ] **Step 3: Verify the deployed page**

```bash
curl -s -D - -o /dev/null -H 'accept: text/html' https://live.obsidian-sync.workers.dev/
```

Expected: `x-frame-options: DENY` and the new CSP header are present, proving the new version is live. Also verify a wrong password still returns `401` and does not contain `obsidian://setuplivesync`.

- [ ] **Step 4: Verify the one-view behavior with the page password**

In the browser, enter the current page password, confirm the setup details appear, then refresh. Expected: the password gate appears again. Close and reopen the page; expected: the gate appears again. Do not ask the user to send the password in chat; let them enter it in the browser.

- [ ] **Step 5: Report the result**

Report the deployed version, the checks that passed, and the browser verification. If deployment is not automatic, state that `npm run deploy` is the remaining step.
