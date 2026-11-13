import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  configPassphrase,
  decryptValue,
  encryptValue,
  formatRemote,
  isEncryptedBlob,
  buildProfile,
  decodeSetupUri,
  encodeSetupUri,
  parseRemote,
  readVault,
  SETUP_URI_PREFIX,
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

test('encodes and decodes a setup uri', async () => {
  const settings = { couchDB_PASSWORD: 'p@ss', remoteConfigurations: { 'remote-x': { id: 'remote-x', name: 'n', uri: 'sls+https://admin:p@ss@h/?db=vault', isEncrypted: false } } };
  const uri = await encodeSetupUri(settings, 'uri-pass');
  assert.ok(uri.startsWith(SETUP_URI_PREFIX));
  assert.deepEqual(await decodeSetupUri(uri, 'uri-pass'), settings);
  await assert.rejects(() => decodeSetupUri('obsidian://open?vault=notes', 'uri-pass'), /not a setup URI/);
  await assert.rejects(() => decodeSetupUri(uri, 'wrong-pass'));
});

test('buildProfile keeps the device profile and swaps only the authoritative facts', async () => {
  const profile = {
    couchDB_URI: 'https://old.example', couchDB_USER: 'admin', couchDB_PASSWORD: 'old', couchDB_DBNAME: 'vault',
    encrypt: true, usePathObfuscation: true, encryptInternalMetadata: true,
    passphrase: 'stale', idDerivationVersion: 1, idDerivationKey: 'stale',
    configPassphraseStore: '', encryptedPassphrase: '', encryptedCouchDBConnection: '',
    pluginSyncExtendedSetting: {}, P2P_managedType: 'x',
    remoteConfigurations: { 'remote-old': { id: 'remote-old', name: 'old', uri: 'sls+https://admin:old@old.example/?db=vault', isEncrypted: true } },
  };
  const built = await buildProfile({
    profile,
    remote: { user: 'admin', password: 'new', host: 'live.example', pathname: '/', search: '?db=vault' },
    password: 'new',
    e2eePassphrase: 'e'.repeat(64),
    idDerivationKey: 'k'.repeat(64),
    idDerivationVersion: 1,
    setupPassphrase: 'uri-pass',
  });
  const settings = built.settings;
  assert.equal(settings.couchDB_PASSWORD, 'new');
  assert.equal(settings.couchDB_URI, 'https://live.example');
  assert.equal(settings.couchDB_USER, 'admin');
  assert.equal(settings.couchDB_DBNAME, 'vault');
  assert.equal(settings.passphrase, 'e'.repeat(64));
  assert.equal(settings.idDerivationKey, 'k'.repeat(64));
  assert.equal(settings.idDerivationVersion, 1);
  assert.equal(settings.encrypt, true);
  assert.equal(settings.usePathObfuscation, true);
  assert.equal(settings.configPassphraseStore, '');
  assert.equal(settings.encryptedCouchDBConnection, '');
  assert.equal(settings.encryptedPassphrase, '');
  assert.equal('P2P_managedType' in settings, false);
  assert.equal('pluginSyncExtendedSetting' in settings, false);
  assert.equal(Object.keys(settings.remoteConfigurations).length, 1);
  const [remote] = Object.values(settings.remoteConfigurations);
  assert.match(remote.id, /^remote-[0-9a-z]{8}-[0-9a-z]{6}$/);
  assert.equal(remote.isEncrypted, false);
  assert.equal(remote.uri, 'sls+https://admin:new@live.example/?db=vault');
  assert.deepEqual(await decodeSetupUri(built.uri, 'uri-pass'), settings);
  assert.equal(profile.couchDB_PASSWORD, 'old', 'the caller profile is not mutated');
  assert.equal(Object.keys(profile.remoteConfigurations).length, 1, 'the caller profile is not mutated');
});

test('buildProfile does not add desktop-only keys', async () => {
  const built = await buildProfile({ profile: { remoteConfigurations: {} }, remote: { user: 'admin', password: 'n', host: 'h', pathname: '/', search: '' }, password: 'n', e2eePassphrase: 'e', idDerivationKey: 'k', idDerivationVersion: 1, setupPassphrase: 'p' });
  for (const key of ['additionalSuffixOfDatabaseName', 'syncInternalFiles', 'syncInternalFilesTargetPatterns', 'deviceAndVaultName', 'pluginSyncExtendedSetting']) {
    assert.equal(key in built.settings, false, key);
  }
  assert.equal(built.settings.couchDB_URI, 'https://h');
});
