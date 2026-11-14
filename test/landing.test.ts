import { describe, expect, it } from 'vitest';
import { createSetupTicket, landingPage, verifySetupTicket } from '../src/landing';
import type { AppEnv } from '../src/types';

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
});
