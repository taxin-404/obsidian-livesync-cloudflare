import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configPassphrase,
  decryptValue,
  encryptValue,
  isEncryptedBlob,
  DEFAULT_CONFIG_PASSPHRASE,
  ENCRYPTED_PREFIX,
  PBKDF2_ITERATIONS,
} from '../scripts/livesync-config.mjs';

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
