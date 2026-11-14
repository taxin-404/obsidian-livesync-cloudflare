# Single-view setup page — design

**Date:** 2026-11-14
**Status:** approved in conversation

## Intent

The setup page exposes the setup URI and passphrase (or the raw CouchDB
credentials). Today the password POST returns the setup HTML directly. A
refresh resubmits that POST, and reopening the tab can restore the result, so
the secrets reappear without a password prompt. One password entry should show
the details once; refresh, close, a new visit, or a back/forward restore should
show the password gate again.

## What exists today

- `src/landing.ts` handles `GET` and `POST` for `/` and `/index.html` when the
  request accepts HTML.
- `GET` shows the password gate. A correct `POST` returns the setup HTML in the
  POST response. There is no cookie or session.
- Responses already use `cache-control: no-store`, `referrer-policy:
  no-referrer`, and `x-robots-tag: noindex`.
- `test/worker.test.ts` currently expects a correct `POST` to return `200` with
  the setup details.

## Goals

1. A correct password leads to one view of the setup details.
2. Refreshing, closing the page, opening a new tab, or restoring the page from
   the browser's back/forward cache shows the password gate again.
3. No password or setup detail appears in the URL or browser history.
4. No persistent login and no new Cloudflare binding, secret, or paid feature.
5. A wrong password still returns `401` and never exposes setup details.
6. The setup page remains usable without JavaScript for viewing/copying; the
   existing copy buttons keep working.

## Non-goals

- Rate limiting, two-factor authentication, or changing password rotation.
- Multi-user accounts.
- Preventing someone who has already seen or copied the details from using
  them.

## Anti-goals

- A normal five-minute session where refresh skips the password.
- Putting the setup URI, passphrase, or ticket in the URL/history.
- A server-side session store or a new KV/Durable Object binding.

## Approaches considered

1. **Short-lived view ticket cookie (chosen).** A correct `POST` redirects to a
   clean `GET` with a signed, 60-second, HttpOnly cookie. The `GET` serves the
   setup page and clears the cookie in the same response. Refresh/close has no
   ticket and shows the gate. No URL secrets, no persistent login, no new
   binding, and testable end to end.
2. **JavaScript-only history cleanup.** Keep returning setup from the `POST`,
   then rewrite history and reload when the page returns. Fewer server changes,
   but depends on JavaScript and browser cache behavior and is weaker.
3. **Short session cookie.** Simple, but refresh would skip the password, which
   fails the request.

## Design

### Ticket and redirect

- On a correct `POST`, issue a cookie named `__Host-livesync_setup` on HTTPS
  (`livesync_setup` on HTTP for local development), then return `303` to `/`.
- Cookie attributes: `Path=/; HttpOnly; SameSite=Strict; Max-Age=60`, plus
  `Secure` on HTTPS. No `Domain`.
- Ticket value: `v1.<expiresAt>.<nonce>.<signature>`.
  - `expiresAt` is epoch milliseconds, 60 seconds after issue.
  - `nonce` is 16 random bytes, base64url.
  - `signature` is HMAC-SHA256 over `v1.<expiresAt>.<nonce>` using a key derived
    from the active page password (`PAGE_PASSWORD || COUCHDB_PASSWORD`) with a
    fixed domain-separation string.
- The ticket is a bearer credential only for the setup view. A copied ticket is
  valid for at most 60 seconds; the browser is instructed to delete it after
  the first view. No server-side session state is added.

### Serving and clearing

- `GET` looks for the cookie:
  - valid and unexpired: serve the setup page and clear the cookie with
    `Max-Age=0` in the same response;
  - missing, malformed, expired, or bad signature: show the gate, and clear the
    cookie if one was sent.
- A wrong `POST` continues to show the gate with `401`.
- A correct `POST` never includes setup details in its own body.

### Cache and framing

- All page responses keep `cache-control: no-store`.
- The setup response adds `vary: cookie` so a cache cannot mix ticketed and
  unticketed responses.
- Add `x-frame-options: DENY` and
  `content-security-policy: frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  to page responses as small hardening; these directives do not restrict the
  existing inline script or stylesheet.
- The setup page includes a `pageshow` listener that reloads when the browser
  restores it from the back/forward cache.

### Tests

- Update the existing page test in `test/worker.test.ts`:
  - correct `POST` returns `303`, `Location: /`, and a ticket cookie with the
    expected security attributes;
  - `GET` with that cookie returns the setup details and clears the cookie;
  - `GET` without the cookie returns the gate;
  - a wrong password still returns `401` and no setup details;
  - a tampered ticket and an expired ticket return the gate;
  - setup and gate responses keep the no-store and framing headers.
- Run `npm run types:check`, `npm run check`, the landing/page tests, and
  `npm run dry-run` before deploying.

## Decisions left to the builder

- Exact helper names and whether the ticket helpers live in `landing.ts` or a
  small adjacent module.
- Whether to keep the test in `worker.test.ts` or add a focused
  `test/landing.test.ts`; either is fine as long as the behavior above is
  covered.
- Whether the `pageshow` guard belongs only on the setup page or on both pages.
