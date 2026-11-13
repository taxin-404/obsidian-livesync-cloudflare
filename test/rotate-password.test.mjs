import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeSetupUri, readVault } from '../scripts/livesync-config.mjs';
import { fixture, pageHtml, profileFor, snapshot } from './helpers/vault-fixture.mjs';
import { generatePassword, generateSetupPassphrase, parseArgs, rotate } from '../scripts/rotate-password.mjs';

const page = async (profile = profileFor()) => pageHtml(await encodeSetupUri(profile, 'old-uri-pass'));

/**
 * Simulates the deployment the commands talk to: the page serves whatever
 * secrets were last pushed, the gate and the database accept whichever server
 * password is current.
 */
async function deployment(vault, overrides = {}) {
  const calls = [];
  let servedUri = await encodeSetupUri(
    profileFor({
      password: vault.password,
      e2eePassphrase: vault.e2eePassphrase,
      idDerivationKey: vault.idDerivationKey,
    }),
    'old-uri-pass',
  );
  let servedPassphrase = 'old-uri-pass';
  let gatePassword = vault.password;

  const putSecret = async (name, value) => {
    if (overrides.failOn === name) throw new Error('boom');
    calls.push([name, value]);
    if (name === 'SETUP_URI') servedUri = value;
    if (name === 'SETUP_URI_PASSPHRASE') servedPassphrase = value;
    if (name === 'COUCHDB_PASSWORD') gatePassword = value;
  };
  const fetchPage = async (candidate) =>
    candidate === gatePassword ? pageHtml(servedUri, servedPassphrase) : '<html>sign in</html>';
  const fetchAuth = overrides.fetchAuth ?? (async (candidate) => (candidate === gatePassword ? 200 : 401));

  return { calls, putSecret, fetchPage, fetchAuth };
}

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

test('rotates every secret and verifies before committing local files', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  const result = await rotate({ ...vault, ...fake });

  assert.deepEqual(fake.calls.map(([name]) => name), ['SETUP_URI', 'SETUP_URI_PASSPHRASE', 'COUCHDB_PASSWORD']);
  assert.equal(fake.calls[0][1], result.setupUri);
  assert.equal(fake.calls[1][1], result.setupPassphrase);

  const after = await readVault(vault.vaultDir);
  assert.equal(after.remote.password, result.password);
  assert.equal(after.legacyConnection.couchDB_PASSWORD, result.password);
  assert.equal(after.e2eePassphrase, vault.e2eePassphrase);
  assert.equal(after.idDerivationKey, vault.idDerivationKey);
  assert.equal((await readFile(vault.passwordFile, 'utf8')).trim(), result.password);

  const state = await snapshot(vault);
  assert.equal(state.passwordTemp, null, 'no staged password file is left behind');
  assert.equal(state.dataTemp, null, 'no staged data file is left behind');

  const steps = result.steps.join('\n');
  assert.equal(steps.includes(result.password), false);
  assert.equal(steps.includes(result.setupPassphrase), false);
  assert.equal(steps.includes(vault.password), false);
});

test('restores the already-pushed secrets and discards the staged files when the password push fails', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { failOn: 'COUCHDB_PASSWORD' });
  const before = await snapshot(vault);

  await assert.rejects(() => rotate({ ...vault, ...fake }), /failed to push COUCHDB_PASSWORD: boom.*restored/s);

  assert.deepEqual(fake.calls.map(([name]) => name), [
    'SETUP_URI',
    'SETUP_URI_PASSPHRASE',
    'SETUP_URI_PASSPHRASE',
    'SETUP_URI',
  ]);
  assert.deepEqual(await snapshot(vault), before, 'production files and staged files are untouched');
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

test('refuses before touching the server when the page has no setup URI', async () => {
  const vault = await fixture();
  const before = await snapshot(vault);
  const calls = [];
  await assert.rejects(
    () =>
      rotate({
        ...vault,
        putSecret: async (name) => calls.push(name),
        fetchPage: async () => '<html>sign in</html>',
        fetchAuth: async () => 200,
      }),
    /did not return a setup URI.*PAGE_PASSWORD/s,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(await snapshot(vault), before);
});

test('dry run changes nothing', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  const before = await snapshot(vault);
  const result = await rotate({ ...vault, ...fake, dryRun: true });
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await snapshot(vault), before);
  assert.ok(result.steps.length > 0);
  assert.match(result.steps.join('\n'), /dry run/i);
});

test('never prints a secret in the returned steps', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  const result = await rotate({ ...vault, ...fake, dryRun: true });
  const text = result.steps.join('\n');
  assert.equal(text.includes(result.password), false);
  assert.equal(text.includes(result.setupPassphrase), false);
  assert.equal(text.includes(vault.password), false);
});

test('rolls back and keeps local files when the old password still authenticates', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { fetchAuth: async () => 200 });
  const before = await snapshot(vault);
  await assert.rejects(() => rotate({ ...vault, ...fake }), /old password still authenticates.*restored/s);
  assert.deepEqual(fake.calls.map(([name]) => name), [
    'SETUP_URI',
    'SETUP_URI_PASSPHRASE',
    'COUCHDB_PASSWORD',
    'COUCHDB_PASSWORD',
    'SETUP_URI_PASSPHRASE',
    'SETUP_URI',
  ]);
  assert.deepEqual(await snapshot(vault), before);
});

test('fails before any push when the local files cannot be staged', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  const before = await snapshot(vault);
  await chmod(vault.vaultDir, 0o500);
  try {
    await assert.rejects(() => rotate({ ...vault, ...fake }), /could not stage the local files.*server was not changed/s);
  } finally {
    await chmod(vault.vaultDir, 0o700);
  }
  assert.deepEqual(fake.calls, []);
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

test('accepts a password file override and an account id', () => {
  assert.deepEqual(parseArgs(['--vault', '/v', '--password-file', '/p', '--account-id', 'abc', '--force', '--json']), {
    vault: '/v',
    worker: 'live',
    dryRun: false,
    force: true,
    json: true,
    passwordFile: '/p',
    accountId: 'abc',
  });
});

test('rejects an unknown flag and a missing value', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
  assert.throws(() => parseArgs(['--vault']), /--vault needs a value/);
});
