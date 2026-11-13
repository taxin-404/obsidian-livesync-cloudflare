import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { isObsidianRunning, preflightFailure } from '../scripts/livesync-cli.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('detects Obsidian running as the Electron app bundle', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '/opt/obsidian/app.asar'], {
    stdio: 'ignore',
  });
  try {
    let detected = false;
    for (let attempt = 0; attempt < 100 && !detected; attempt++) {
      detected = isObsidianRunning();
      if (!detected) await sleep(20);
    }
    assert.equal(detected, true);
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
