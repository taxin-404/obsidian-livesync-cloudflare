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
