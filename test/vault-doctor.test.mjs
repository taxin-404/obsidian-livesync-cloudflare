import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('returns no vaults when the registry is malformed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'livesync-registry-'));
  const registryPath = path.join(dir, 'obsidian.json');
  await writeFile(registryPath, '{ this is not json');
  assert.deepEqual(await discoverVaults({ registryPath }), []);
});

test('counts two vaults that share a basename as a collision', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const root = await mkdtemp(path.join(tmpdir(), 'livesync-roots-'));
  const aDir = path.join(root, 'a', 'notes');
  const bDir = path.join(root, 'b', 'notes');
  await mkdir(path.dirname(aDir), { recursive: true });
  await mkdir(path.dirname(bDir), { recursive: true });
  await rename(a.vaultDir, aDir);
  await rename(b.vaultDir, bDir);
  const report = await doctorVaults([aDir, bDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
  assert.equal(report.collisions[0].vaults.length, 2);
});

test('never prints a secret from a vault that cannot be read', async () => {
  const secret = 's3cr3tkey';
  const dir = await mkdtemp(path.join(tmpdir(), 'livesync-broken-'));
  const pluginDir = path.join(dir, '.obsidian', 'plugins', 'obsidian-livesync');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, 'data.json'), `{"configPassphraseStore": ${secret},}`);
  const report = await doctorVaults([dir]);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(typeof report.vaults[0].error, 'string');
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
