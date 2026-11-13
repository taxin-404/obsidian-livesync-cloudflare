import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeSetupUri, readVault } from '../scripts/livesync-config.mjs';
import { fixture, pageHtml, profileFor, snapshot } from './helpers/vault-fixture.mjs';
import { generatePassword, generateSetupPassphrase, parseArgs, rotate } from '../scripts/rotate-password.mjs';

const page = async (profile = profileFor()) => pageHtml(await encodeSetupUri(profile, 'old-uri-pass'));

test('generates a 28 character alphanumeric password', () => {
  const seen = new Set();
  for (let index = 0; index < 500; index++) {
    const password = generatePassword();
    assert.match(password, /^[A-Za-z0-9]{28}$/);
    seen.add(password);
  }
  assert.equal(seen.size, 500);
});

test('generates a 32 character base64url setup passphrase', () => {
  const seen = new Set();
  for (let index = 0; index < 200; index++) {
    const passphrase = generateSetupPassphrase();
    assert.match(passphrase, /^[A-Za-z0-9_-]{32}$/);
    seen.add(passphrase);
  }
  assert.equal(seen.size, 200);
});

test('rotates every secret and verifies before writing local state', async () => {
  const calls = [];
  const vault = await fixture();
  let servedUri = await encodeSetupUri(profileFor(), 'old-uri-pass');
  let servedPassphrase = 'old-uri-pass';
  const result = await rotate({
    ...vault,
    putSecret: async (name, value) => {
      calls.push(['secret', name, value]);
      if (name === 'SETUP_URI') servedUri = value;
      if (name === 'SETUP_URI_PASSPHRASE') servedPassphrase = value;
    },
    fetchPage: async () => pageHtml(servedUri, servedPassphrase),
    fetchAuth: async (password) => (password === vault.password ? 401 : 200),
  });
  assert.deepEqual(calls.slice(0, 3).map(([, name]) => name), [
    'COUCHDB_PASSWORD',
    'SETUP_URI',
    'SETUP_URI_PASSPHRASE',
  ]);
  assert.equal(calls[1][2], result.setupUri);
  assert.equal(calls[2][2], result.setupPassphrase);
  const after = await readVault(vault.vaultDir);
  assert.equal(after.remote.password, result.password);
  assert.equal(after.legacyConnection.couchDB_PASSWORD, result.password);
  assert.equal(after.e2eePassphrase, vault.e2eePassphrase);
  assert.equal(after.idDerivationKey, vault.idDerivationKey);
  assert.equal((await readFile(vault.passwordFile, 'utf8')).trim(), result.password);
  const steps = result.steps.join('\n');
  assert.equal(steps.includes(result.password), false);
  assert.equal(steps.includes(result.setupPassphrase), false);
  assert.equal(steps.includes(vault.password), false);
});

test('restores the pushed secrets and leaves local files untouched when a later push fails', async () => {
  const vault = await fixture();
  const before = await snapshot(vault);
  const calls = [];
  await assert.rejects(
    () =>
      rotate({
        ...vault,
        putSecret: async (name, value) => {
          calls.push([name, value]);
          if (name === 'SETUP_URI') throw new Error('boom');
        },
        fetchPage: () => page(),
        fetchAuth: async () => 200,
      }),
    /boom.*restored/s,
  );
  assert.deepEqual(calls.map(([name]) => name), ['COUCHDB_PASSWORD', 'SETUP_URI', 'COUCHDB_PASSWORD']);
  assert.equal(calls[2][1], vault.password, 'the old password is pushed back');
  assert.deepEqual(await snapshot(vault), before);
});

test('refuses while Obsidian is running unless forced', async () => {
  const vault = await fixture();
  await assert.rejects(() => rotate({ ...vault, obsidianRunning: () => true }), /Obsidian is running/);
  await assert.rejects(() => rotate({ ...vault, obsidianRunning: () => true, dryRun: true }), /Obsidian is running/);
});

test('refuses when the vault and the password file disagree', async () => {
  const vault = await fixture();
  await writeFile(vault.passwordFile, 'different\n', { mode: 0o600 });
  await assert.rejects(
    () => rotate({ ...vault, putSecret: async () => {}, fetchPage: () => page(), fetchAuth: async () => 200 }),
    /vault password and password file disagree/,
  );
});

test('refuses before writing when the page has no setup URI', async () => {
  const vault = await fixture();
  const before = await snapshot(vault);
  await assert.rejects(
    () => rotate({ ...vault, fetchPage: async () => '<html>sign in</html>', fetchAuth: async () => 200 }),
    /did not return a setup URI/,
  );
  assert.deepEqual(await snapshot(vault), before);
});

test('dry run changes nothing', async () => {
  const vault = await fixture();
  const before = await snapshot(vault);
  const result = await rotate({ ...vault, dryRun: true, fetchPage: () => page(), fetchAuth: async () => 200 });
  assert.deepEqual(await snapshot(vault), before);
  assert.ok(result.steps.length > 0);
  assert.match(result.steps.join('\n'), /dry run/i);
});

test('never prints a secret in the returned steps', async () => {
  const vault = await fixture();
  const result = await rotate({
    ...vault,
    fetchPage: () => page(),
    fetchAuth: async () => 200,
    putSecret: async () => {},
    dryRun: true,
  });
  const text = result.steps.join('\n');
  assert.equal(text.includes(result.password), false);
  assert.equal(text.includes(result.setupPassphrase), false);
  assert.equal(text.includes(vault.password), false);
});

test('fails verification without writing local state when the old password still works', async () => {
  const vault = await fixture();
  const before = await snapshot(vault);
  await assert.rejects(
    () => rotate({ ...vault, putSecret: async () => {}, fetchPage: () => page(), fetchAuth: async () => 200 }),
    /old password still authenticates.*restored/s,
  );
  assert.deepEqual(await snapshot(vault), before);
});

test('parses the rotation arguments', () => {
  assert.deepEqual(parseArgs(['--vault', '/v', '--worker', 'live', '--dry-run']), {
    vault: '/v',
    worker: 'live',
    dryRun: true,
    force: false,
    json: false,
  });
});

test('accepts a password file override', () => {
  assert.deepEqual(parseArgs(['--vault', '/v', '--password-file', '/p', '--force', '--json']), {
    vault: '/v',
    worker: 'live',
    dryRun: false,
    force: true,
    json: true,
    passwordFile: '/p',
  });
});

test('rejects an unknown flag and a missing value', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
  assert.throws(() => parseArgs(['--vault']), /--vault needs a value/);
});
