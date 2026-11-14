import { describe, expect, it } from 'vitest';
import { createSetupTicket, landingPage, verifySetupTicket } from '../src/landing';
import { decodeQrSvg } from './qr-scan';
import type { AppEnv } from '../src/types';

const password = 'test-password';
const issuedAt = 1_800_000_000_000;

function decodePageQr(html: string): string | null {
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0];
  return svg ? decodeQrSvg(svg) : null;
}

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
    // Flip the second-to-last character: the final Base64url character carries
    // padding bits, so changing it can decode to the same signature.
    const last = ticket.at(-1);
    const flipped = ticket.at(-2) === 'A' ? 'B' : 'A';
    const tampered = `${ticket.slice(0, -2)}${flipped}${last}`;
    await expect(verifySetupTicket(tampered, password, issuedAt + 1)).resolves.toBe(false);
  });
});

describe('landing page', () => {
  it('redirects a correct password with a non-secure cookie on plain HTTP', async () => {
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
  });

  it('fails closed when no page password is configured', async () => {
    const missing = await landingPage(new Request('https://pouch.test/', {
      headers: { accept: 'text/html' },
    }), {} as AppEnv);
    expect(missing.status).toBe(503);
  });

  it('shows the gate for a malformed cookie and clears it', async () => {
    const env = { COUCHDB_PASSWORD: 'test-password' } as AppEnv;
    const page = await landingPage(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: '__Host-livesync_setup=not-a-ticket' },
    }), env);
    const html = await page.text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain('obsidian://setuplivesync');
    expect(page.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('shows the gate when a malformed cookie precedes a valid duplicate', async () => {
    const env = { COUCHDB_PASSWORD: 'test-password' } as AppEnv;
    const valid = await createSetupTicket('test-password');
    const page = await landingPage(new Request('https://pouch.test/', {
      headers: {
        accept: 'text/html',
        cookie: `__Host-livesync_setup=not-a-ticket; __Host-livesync_setup=${valid}`,
      },
    }), env);
    const html = await page.text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain('obsidian://setuplivesync');
  });

  it('renders a QR that carries the setup URI', async () => {
    const uri = 'obsidian://setuplivesync?settings=test';
    const env = {
      COUCHDB_PASSWORD: 'test-password',
      SETUP_URI: uri,
      SETUP_URI_PASSPHRASE: 'test-uri-passphrase',
    } as AppEnv;
    const ticket = await createSetupTicket('test-password');
    const response = await landingPage(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: `__Host-livesync_setup=${ticket}` },
    }), env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<figure class="qr">');
    expect(html).toContain('id="v-uri"');
    expect(decodePageQr(html)).toBe(uri);
  });

  it('still serves the setup URI when it is too large for a QR code', async () => {
    const uri = `obsidian://setuplivesync?settings=${'x'.repeat(4_000)}`;
    const env = {
      COUCHDB_PASSWORD: 'test-password',
      SETUP_URI: uri,
      SETUP_URI_PASSPHRASE: 'test-uri-passphrase',
    } as AppEnv;
    const ticket = await createSetupTicket('test-password');
    const response = await landingPage(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: `__Host-livesync_setup=${ticket}` },
    }), env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('id="v-uri"');
    expect(html).not.toContain('<figure class="qr">');
  });

  it('omits the QR when no setup URI is configured', async () => {
    const env = { COUCHDB_PASSWORD: 'test-password', COUCHDB_USERNAME: 'admin' } as AppEnv;
    const ticket = await createSetupTicket('test-password');
    const response = await landingPage(new Request('https://pouch.test/', {
      headers: { accept: 'text/html', cookie: `__Host-livesync_setup=${ticket}` },
    }), env);
    const html = await response.text();
    expect(html).toContain('id="v-url"');
    expect(html).not.toContain('<figure class="qr">');
    expect(html).not.toContain('<svg');
  });
});
