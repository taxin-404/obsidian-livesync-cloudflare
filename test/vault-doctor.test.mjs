import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { discoverVaults, doctorVaults, parseArgs } from '../scripts/vault-doctor.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

test('reports a collision when two vaults share a remote', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
  assert.equal(report.collisions[0].vaults.length, 2);
});

test('reports no collision when vaults use different remotes', async () => {
  const a = await makeVault();
  const b = await makeVault({ remoteProduct: 'sls+https://admin:pw@other.test/?db=vault' });
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.collisions, []);
});

test('counts a vault that has no active remote configuration', async () => {
  const a = await makeVault();
  const b = await makeVault({ activeConfigurationId: '' });
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
});

test('detects a collision through the legacy connection only', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const raw = JSON.parse(await readFile(b.dataPath, 'utf8'));
  delete raw.remoteConfigurations;
  await writeFile(b.dataPath, `${JSON.stringify(raw, null, 2)}\n`);
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
});

test('reads a plaintext remote entry', async () => {
  const a = await makeVault();
  const b = await makeVault({ storedRemoteUri: 'sls+https://admin:pw@host.test/?db=vault' });
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
});

test('returns no vaults when the registry is missing', async () => {
  const dirs = await discoverVaults({ registryPath: '/definitely/not/here.json' });
  assert.deepEqual(dirs, []);
});

test('never prints a secret', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  const text = JSON.stringify(report);
  assert.equal(text.includes(a.password), false);
  assert.equal(text.includes(a.e2eePassphrase), false);
  assert.equal(text.includes(a.idDerivationKey), false);
  assert.equal(text.includes('%$'), false);
});

test('parses the doctor arguments', () => {
  assert.deepEqual(parseArgs(['--vault', '/a', '--root', '/b', '--json']), {
    vaults: ['/a'],
    roots: ['/b'],
    json: true,
  });
  assert.deepEqual(parseArgs([]), { vaults: [], roots: [], json: false });
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
  assert.throws(() => parseArgs(['--vault']), /--vault needs a value/);
});
