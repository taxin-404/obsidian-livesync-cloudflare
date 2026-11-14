import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeSetupUri, decodeSetupUri, readSetupPage, readVault } from '../scripts/livesync-config.mjs';
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
  let passphraseLag = 0;
  let authPassword = overrides.authPassword ?? vault.password;
  let gatePassword = overrides.pagePassword ?? overrides.gatePassword ?? authPassword;

  const putSecret = async (name, value) => {
    if (overrides.failOn === name) throw new Error('boom');
    calls.push([name, value]);
    if (name === 'SETUP_URI') servedUri = value;
    if (name === 'SETUP_URI_PASSPHRASE') {
      servedPassphrase = value;
      passphraseLag = overrides.passphraseLag ?? 0;
    }
    if (name === 'COUCHDB_PASSWORD') {
      authPassword = value;
      // Without a separate page password the gate follows COUCHDB_PASSWORD.
      if (!overrides.pagePassword) gatePassword = value;
    }
  };
  const fetchPage = async (candidate) => {
    if (candidate !== gatePassword) return '<html>sign in</html>';
    const passphrase = passphraseLag > 0 ? 'old-uri-pass' : servedPassphrase;
    if (passphraseLag > 0) passphraseLag--;
    return pageHtml(servedUri, passphrase);
  };
  const fetchAuth = overrides.fetchAuth ?? (async (candidate) => (candidate === authPassword ? 200 : 401));

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

test('rotates with a separate page password and leaves it unchanged', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { pagePassword: 'page-pass-1' });
  const result = await rotate({ ...vault, ...fake, pagePassword: 'page-pass-1' });

  assert.deepEqual(fake.calls.map(([name]) => name), ['SETUP_URI', 'SETUP_URI_PASSPHRASE', 'COUCHDB_PASSWORD']);
  assert.equal(await fake.fetchAuth(vault.password), 401, 'the old database password stops working');
  assert.equal(await fake.fetchAuth(result.password), 200, 'the new database password works');
  assert.equal(await fake.fetchAuth('page-pass-1'), 401, 'the page password is not a database password');
  const served = readSetupPage(await fake.fetchPage('page-pass-1'));
  assert.equal(served.uri, result.setupUri, 'the page still opens with the page password');
});

test('reads the page password from its own file', async () => {
  const vault = await fixture();
  const pagePasswordFile = join(vault.vaultDir, 'page-password');
  await writeFile(pagePasswordFile, 'file-page-pass\n', { mode: 0o600 });
  const fake = await deployment(vault, { pagePassword: 'file-page-pass' });
  const result = await rotate({ ...vault, ...fake, pagePasswordFile });

  assert.equal(await fake.fetchAuth(result.password), 200);
  assert.equal(readSetupPage(await fake.fetchPage('file-page-pass')).uri, result.setupUri);
});

test('refuses to rotate when the page password is missing', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { pagePassword: 'page-pass-1' });
  const before = await snapshot(vault);
  await assert.rejects(() => rotate({ ...vault, ...fake }), /did not accept the page password/);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await snapshot(vault), before);
});

test('rebuild replaces the setup pair and the password when the saved password is lost', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { gatePassword: 'typed-in-the-dashboard', authPassword: 'typed-in-the-dashboard' });
  const result = await rotate({ ...vault, ...fake, rebuild: true, verifyDelayMs: 1 });

  assert.deepEqual(fake.calls.map(([name]) => name), ['SETUP_URI', 'SETUP_URI_PASSPHRASE', 'COUCHDB_PASSWORD']);
  assert.equal(fake.calls[2][1], result.password);
  assert.equal(await fake.fetchAuth(result.password), 200);
  assert.equal(await fake.fetchAuth(vault.password), 401);
  assert.equal(await fake.fetchAuth('typed-in-the-dashboard'), 401);

  const served = readSetupPage(await fake.fetchPage(result.password));
  assert.equal(served.uri, result.setupUri);
  assert.equal(served.passphrase, result.setupPassphrase);
  const settings = await decodeSetupUri(served.uri, served.passphrase);
  assert.equal(settings.couchDB_PASSWORD, result.password);
  assert.equal(settings.passphrase, vault.e2eePassphrase);
  assert.equal(settings.idDerivationKey, vault.idDerivationKey);
  assert.equal(settings.activeConfigurationId, undefined, 'the new device is not pinned to an old remote id');
  assert.equal(settings.encryptedPassphrase, '');
  assert.equal(settings.configPassphraseStore, '');
  assert.equal(settings.encrypt, true);
  assert.equal(settings.liveSync, undefined, 'per-device preferences are not copied');
  assert.ok(served.uri.length < 4800, 'the URI fits in a Worker secret');

  const after = await readVault(vault.vaultDir);
  assert.equal(after.remote.password, result.password);
  assert.equal(after.legacyConnection.couchDB_PASSWORD, result.password);
  assert.equal((await readFile(vault.passwordFile, 'utf8')).trim(), result.password);
  assert.equal((await snapshot(vault)).dataTemp, null);
  assert.equal((await snapshot(vault)).passwordTemp, null);
});

test('rebuild refuses when the saved password still works', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  const before = await snapshot(vault);
  await assert.rejects(
    () => rotate({ ...vault, ...fake, rebuild: true }),
    /still authenticates.*without --rebuild/s,
  );
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await snapshot(vault), before);
});

test('rebuild never opens the gated page', async () => {
  const vault = await fixture();
  const result = await rotate({
    ...vault,
    putSecret: async () => assert.fail('a dry run must not push'),
    fetchPage: async () => assert.fail('a rebuild must not read the page'),
    fetchAuth: async () => 401,
    rebuild: true,
    dryRun: true,
  });
  assert.match(result.steps.join('\n'), /rebuild/i);
  assert.match(result.steps.join('\n'), /dry run/i);
});

test('refuses a setup URI too large for a Worker secret before touching the server', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  const before = await snapshot(vault);
  const huge = { ...profileFor(), couchDB_CustomHeaders: 'x'.repeat(6000) };
  await assert.rejects(
    () => rotate({ ...vault, ...fake, fetchPage: async () => pageHtml(await encodeSetupUri(huge, 'old-uri-pass')) }),
    /over the 4800-byte Worker secret limit/,
  );
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await snapshot(vault), before);
});

test('restores the already-pushed secrets and discards the staged files when the password push fails', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { failOn: 'COUCHDB_PASSWORD' });
  const before = await snapshot(vault);

  await assert.rejects(() => rotate({ ...vault, ...fake }), /failed to push COUCHDB_PASSWORD: boom.*re-pushed/s);

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
    /did not return a setup URI.*did not accept the page password/s,
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
  await assert.rejects(
    () => rotate({ ...vault, ...fake, verifyAttempts: 1, verifyDelayMs: 0 }),
    /old password still authenticates.*re-pushed/s,
  );
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

test('retries the page check while the setup passphrase propagates', async () => {
  const vault = await fixture();
  const fake = await deployment(vault, { passphraseLag: 1 });
  const sleeps = [];
  const result = await rotate({ ...vault, ...fake, verifyDelayMs: 1, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [1], 'one page check saw the new URI with the old passphrase');
  assert.equal((await readVault(vault.vaultDir)).remote.password, result.password);
});

test('retries verification while the old password is still accepted', async () => {
  const vault = await fixture();
  const fake = await deployment(vault);
  let oldChecks = 0;
  const fetchAuth = async (candidate) => {
    if (candidate === vault.password) {
      oldChecks++;
      return oldChecks <= 2 ? 200 : 401;
    }
    return 200;
  };
  const sleeps = [];
  const result = await rotate({
    ...vault,
    ...fake,
    fetchAuth,
    verifyDelayMs: 1,
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(oldChecks, 3, 'the pre-push check plus two verification attempts');
  assert.deepEqual(sleeps, [1]);
  assert.equal((await readVault(vault.vaultDir)).remote.password, result.password);
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
    rebuild: false,
    force: false,
    json: false,
  });
});

test('accepts a password file override, an account id and --rebuild', () => {
  assert.deepEqual(
    parseArgs(['--vault', '/v', '--password-file', '/p', '--account-id', 'abc', '--force', '--json', '--rebuild']),
    {
      vault: '/v',
      worker: 'live',
      dryRun: false,
      rebuild: true,
      force: true,
      json: true,
      passwordFile: '/p',
      accountId: 'abc',
    },
  );
});

test('accepts a separate page password file', () => {
  assert.deepEqual(parseArgs(['--vault', '/v', '--page-password-file', '/pp']), {
    vault: '/v',
    worker: 'live',
    dryRun: false,
    rebuild: false,
    force: false,
    json: false,
    pagePasswordFile: '/pp',
  });
});

test('rejects an unknown flag and a missing value', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
  assert.throws(() => parseArgs(['--vault']), /--vault needs a value/);
});
