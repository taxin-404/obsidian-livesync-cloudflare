import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflightFailure } from '../scripts/livesync-cli.mjs';

test('names an ambiguous Cloudflare account', () => {
  const message = preflightFailure('live', 'More than one account available but unable to select one in non-interactive mode.');
  assert.match(message, /more than one Cloudflare account/i);
  assert.match(message, /--account-id/);
  assert.match(message, /nothing was changed/);
});

test('names a Worker that is not in the account', () => {
  const message = preflightFailure('obsidian-sync', 'Worker "obsidian-sync" not found.');
  assert.match(message, /Worker "obsidian-sync" is not reachable/);
  assert.match(message, /--worker/);
  assert.match(message, /nothing was changed/);
});
