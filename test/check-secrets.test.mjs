import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeSetupUri } from '../scripts/livesync-config.mjs';
import { checkSecrets, parseArgs } from '../scripts/check-secrets.mjs';
import { fixture, pageHtml, profileFor } from './helpers/vault-fixture.mjs';

const LINK_NAMES = [
  'server password',
  'setup page gate',
  'setup URI password',
  'setup URI device profile',
  'vault connection',
];

const page = async (profile) => pageHtml(await encodeSetupUri(profile, 'uri-pass'), 'uri-pass');
const failed = (report) => report.links.filter((link) => !link.ok).map((link) => link.name);

async function goodProfile(vault) {
  return profileFor({
    password: vault.password,
    e2eePassphrase: vault.e2eePassphrase,
    idDerivationKey: vault.idDerivationKey,
  });
}

test('reports every link green when the deployment is consistent', async () => {
  const vault = await fixture();
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 200,
    fetchPage: async () => page(await goodProfile(vault)),
  });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.links.map((link) => link.name), LINK_NAMES);
  assert.ok(report.links.every((link) => link.ok && link.detail.length > 0));
});

test('names the stale setup URI password', async () => {
  const vault = await fixture();
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 200,
    fetchPage: async () => page(profileFor({ password: 'stale-password', e2eePassphrase: vault.e2eePassphrase, idDerivationKey: vault.idDerivationKey })),
  });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(failed(report), ['setup URI password']);
  assert.match(report.links.find((link) => !link.ok).detail, /different password/);
});

test('names a mismatched ID derivation key as the reason new devices would duplicate the vault', async () => {
  const vault = await fixture();
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 200,
    fetchPage: async () => page(profileFor({ password: vault.password, e2eePassphrase: vault.e2eePassphrase, idDerivationKey: 'b'.repeat(64) })),
  });
  assert.deepEqual(failed(report), ['setup URI device profile']);
  assert.match(report.links.find((link) => !link.ok).detail, /duplicate/);
});

test('names a mismatched end-to-end passphrase', async () => {
  const vault = await fixture();
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 200,
    fetchPage: async () => page(profileFor({ password: vault.password, e2eePassphrase: 'f'.repeat(64), idDerivationKey: vault.idDerivationKey })),
  });
  assert.deepEqual(failed(report), ['setup URI device profile']);
  assert.match(report.links.find((link) => !link.ok).detail, /passphrase/);
});

test('names a setup URI that points at a different server', async () => {
  const vault = await fixture();
  const profile = await goodProfile(vault);
  profile.couchDB_URI = 'https://elsewhere.example';
  const report = await checkSecrets({ ...vault, fetchAuth: async () => 200, fetchPage: async () => page(profile) });
  assert.deepEqual(failed(report), ['setup URI device profile']);
  assert.match(report.links.find((link) => !link.ok).detail, /elsewhere\.example/);
});

test('names a rejected server password and an unreachable page', async () => {
  const vault = await fixture();
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 401,
    fetchPage: async () => '<html>sign in</html>',
  });
  assert.deepEqual(failed(report), [
    'server password',
    'setup page gate',
    'setup URI password',
    'setup URI device profile',
  ]);
  assert.equal(
    report.links.find((link) => link.name === 'setup page gate').detail,
    'the page did not return a setup URI',
  );
});

test('names a vault that disagrees with the saved password', async () => {
  const vault = await fixture();
  await writeFile(vault.passwordFile, 'saved-elsewhere\n', { mode: 0o600 });
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 200,
    fetchPage: async () => page(profileFor({ password: 'saved-elsewhere', e2eePassphrase: vault.e2eePassphrase, idDerivationKey: vault.idDerivationKey })),
  });
  assert.deepEqual(failed(report), ['vault connection']);
});

test('reports an unreadable vault instead of throwing', async () => {
  const vault = await fixture();
  await writeFile(vault.dataPath, '{ not json', 'utf8');
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 200,
    fetchPage: async () => page(profileFor({ password: vault.password, e2eePassphrase: vault.e2eePassphrase, idDerivationKey: vault.idDerivationKey })),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(failed(report), ['setup URI device profile', 'vault connection']);
  assert.match(report.links.at(-1).detail, /could not be read/);
});

test('never prints a secret', async () => {
  const vault = await fixture();
  const report = await checkSecrets({
    ...vault,
    fetchAuth: async () => 401,
    fetchPage: async () => page(await goodProfile(vault)),
  });
  const text = JSON.stringify(report);
  assert.equal(text.includes((await readFile(vault.passwordFile, 'utf8')).trim()), false);
  assert.equal(text.includes(vault.e2eePassphrase), false);
  assert.equal(text.includes(vault.idDerivationKey), false);
  assert.equal(text.includes('obsidian://setuplivesync'), false);
});

test('parses the drift-check arguments', () => {
  assert.deepEqual(parseArgs(['--vault', '/v', '--json']), { vault: '/v', json: true });
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
  assert.throws(() => parseArgs(['--vault']), /--vault needs a value/);
});
