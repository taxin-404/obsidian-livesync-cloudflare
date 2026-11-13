import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  configPassphrase,
  decryptValue,
  encryptValue,
  formatRemote,
  isEncryptedBlob,
  parseRemote,
  readVault,
  writeVault,
  DEFAULT_CONFIG_PASSPHRASE,
  ENCRYPTED_PREFIX,
  PBKDF2_ITERATIONS,
} from '../scripts/livesync-config.mjs';
import { makeVault, readDataFile } from './helpers/vault-fixture.mjs';

test('round-trips unicode plaintext', async () => {
  const secret = 'বাংলা notes — {"a":1} 🔐';
  const blob = await encryptValue(secret, 'pass-1');
  assert.ok(blob.startsWith('%$'));
  assert.equal(await decryptValue(blob, 'pass-1'), secret);
});

test('fails a different passphrase', async () => {
  const blob = await encryptValue('payload', 'right');
  await assert.rejects(() => decryptValue(blob, 'wrong'));
});

test('pins the envelope layout with a fixed random source', async () => {
  const random = (bytes) => new Uint8Array(bytes).fill(7);
  const blob = await encryptValue('fixed', 'fixed-pass', { random });
  assert.equal(blob.slice(0, 2), ENCRYPTED_PREFIX);
  assert.equal(Buffer.from(blob.slice(2), 'base64').length, 32 + 12 + 32 + Buffer.byteLength('fixed') + 16);
  assert.equal(await decryptValue(blob, 'fixed-pass'), 'fixed');
});

test('rejects unknown prefixes without touching crypto', async () => {
  assert.equal(isEncryptedBlob('%$abc'), true);
  assert.equal(isEncryptedBlob('%abc'), false);
  assert.equal(isEncryptedBlob('{"plain":true}'), false);
  assert.equal(isEncryptedBlob(undefined), false);
  await assert.rejects(() => decryptValue('%v2-old', 'pass'), /unsupported encrypted value prefix/);
  await assert.rejects(() => decryptValue('%$short', 'pass'), /invalid encrypted value length/);
});

test('uses the stored config passphrase when present', () => {
  assert.equal(configPassphrase({ configPassphraseStore: '' }), DEFAULT_CONFIG_PASSPHRASE);
  assert.equal(configPassphrase({ configPassphraseStore: 'chosen' }), 'chosen');
  assert.equal(PBKDF2_ITERATIONS, 310000);
});

test('round-trips through the real fixed salt', async () => {
  const blob = await encryptValue('x', DEFAULT_CONFIG_PASSPHRASE);
  assert.equal(await decryptValue(blob, DEFAULT_CONFIG_PASSPHRASE), 'x');
});

test('parses and reformats a sls+ remote uri, keeping path and query', () => {
  const parts = parseRemote('sls+https://admin:p%40ss@example.workers.dev/?db=vault');
  assert.equal(parts.user, 'admin');
  assert.equal(parts.password, 'p@ss');
  assert.equal(parts.host, 'example.workers.dev');
  assert.equal(parts.pathname, '/');
  assert.equal(parts.search, '?db=vault');
  assert.equal(formatRemote({ ...parts, password: 'next' }), 'sls+https://admin:next@example.workers.dev/?db=vault');
});

test('keeps a password with special characters intact', () => {
  const parts = parseRemote('sls+https://admin:old@host.test/?db=vault');
  const uri = formatRemote({ ...parts, password: 'a/b+c=d' });
  assert.equal(parseRemote(uri).password, 'a/b+c=d');
});

test('reads the vault without touching it', async () => {
  const vault = await makeVault();
  const state = await readVault(vault.vaultDir);
  assert.equal(state.e2eePassphrase, vault.e2eePassphrase);
  assert.equal(state.idDerivationKey, vault.idDerivationKey);
  assert.equal(state.idDerivationVersion, 1);
  assert.equal(state.activeRemoteId, 'remote-test');
  assert.equal(state.remote.password, vault.password);
  assert.equal(state.legacyConnection.couchDB_PASSWORD, vault.password);
});

test('round-trips data.json byte for byte', async () => {
  const vault = await makeVault();
  const original = await readDataFile(vault);
  await writeVault(vault.vaultDir, (await readVault(vault.vaultDir)).data);
  assert.equal(await readDataFile(vault), original);
});

test('refuses a vault whose encrypted value has an unknown prefix', async () => {
  const vault = await makeVault({ storedRemoteUri: '%v2-unknown' });
  await assert.rejects(() => readVault(vault.vaultDir), /unsupported encrypted value prefix/);
});

test('refuses a vault with no active remote configuration', async () => {
  const vault = await makeVault();
  const data = JSON.parse(await readDataFile(vault));
  data.activeConfigurationId = 'remote-missing';
  await writeFile(vault.dataPath, `${JSON.stringify(data, null, 2)}\n`);
  await assert.rejects(() => readVault(vault.vaultDir), /no active remote configuration/);
});
