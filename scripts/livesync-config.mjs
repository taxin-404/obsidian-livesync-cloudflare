import { webcrypto } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONFIG_SALT = 'rHGMPtr6oWw7VSa3W3wpa8fT8U';
export const DEFAULT_CONFIG_PASSPHRASE = `*${CONFIG_SALT}`;
export const ENCRYPTED_PREFIX = '%$';
export const PBKDF2_ITERATIONS = 310000;
export const SETUP_URI_PREFIX = 'obsidian://setuplivesync?settings=';

const PBKDF2_SALT_LENGTH = 32;
const HKDF_SALT_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MINIMUM_ENVELOPE_BYTES = PBKDF2_SALT_LENGTH + IV_LENGTH + HKDF_SALT_LENGTH + TAG_LENGTH;

const crypto = globalThis.crypto ?? webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * The plugin encrypts its own configuration with a fixed passphrase unless the
 * user stores one of their own.
 */
export function configPassphrase(settings) {
  const stored = settings?.configPassphraseStore;
  return typeof stored === 'string' && stored.length > 0 ? stored : DEFAULT_CONFIG_PASSPHRASE;
}

export function isEncryptedBlob(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

async function deriveAesKey(passphrase, pbkdf2Salt, hkdfSalt) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), { name: 'PBKDF2', length: 256 }, false, ['deriveKey']);
  const master = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: pbkdf2Salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const hkdf = await crypto.subtle.importKey('raw', await crypto.subtle.exportKey('raw', master), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: hkdfSalt, info: new Uint8Array(), hash: 'SHA-256' },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptValue(plaintext, passphrase, options = {}) {
  const random = options.random ?? randomBytes;
  const pbkdf2Salt = random(PBKDF2_SALT_LENGTH);
  const iv = random(IV_LENGTH);
  const hkdfSalt = random(HKDF_SALT_LENGTH);
  const key = await deriveAesKey(passphrase, pbkdf2Salt, hkdfSalt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encoder.encode(plaintext)));
  const envelope = new Uint8Array(pbkdf2Salt.length + iv.length + hkdfSalt.length + ciphertext.length);
  envelope.set(pbkdf2Salt, 0);
  envelope.set(iv, pbkdf2Salt.length);
  envelope.set(hkdfSalt, pbkdf2Salt.length + iv.length);
  envelope.set(ciphertext, pbkdf2Salt.length + iv.length + hkdfSalt.length);
  return `${ENCRYPTED_PREFIX}${Buffer.from(envelope).toString('base64')}`;
}

export async function decryptValue(blob, passphrase) {
  if (!isEncryptedBlob(blob)) {
    throw new Error(`unsupported encrypted value prefix: ${typeof blob === 'string' ? blob.slice(0, 2) : typeof blob}`);
  }
  const envelope = Buffer.from(blob.slice(ENCRYPTED_PREFIX.length), 'base64');
  if (envelope.length < MINIMUM_ENVELOPE_BYTES) throw new Error('invalid encrypted value length');
  const pbkdf2Salt = envelope.subarray(0, PBKDF2_SALT_LENGTH);
  const iv = envelope.subarray(PBKDF2_SALT_LENGTH, PBKDF2_SALT_LENGTH + IV_LENGTH);
  const hkdfSalt = envelope.subarray(PBKDF2_SALT_LENGTH + IV_LENGTH, PBKDF2_SALT_LENGTH + IV_LENGTH + HKDF_SALT_LENGTH);
  const ciphertext = envelope.subarray(PBKDF2_SALT_LENGTH + IV_LENGTH + HKDF_SALT_LENGTH);
  const key = await deriveAesKey(passphrase, pbkdf2Salt, hkdfSalt);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext);
  return decoder.decode(plaintext);
}

const PLUGIN_DIRECTORY = ['.obsidian', 'plugins', 'obsidian-livesync'];

export function parseRemote(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('sls+')) throw new Error('not a sls+ remote uri');
  const url = new URL(uri.slice('sls+'.length));
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.host,
    pathname: url.pathname,
    search: url.search,
  };
}

export function formatRemote(parts) {
  const user = encodeURIComponent(parts.user ?? '');
  const password = encodeURIComponent(parts.password ?? '');
  const pathname = parts.pathname ?? '/';
  const search = parts.search ?? '';
  return `sls+https://${user}:${password}@${parts.host}${pathname}${search}`;
}

export function dataFilePath(vaultDir) {
  return join(vaultDir, ...PLUGIN_DIRECTORY, 'data.json');
}

export async function readVault(vaultDir) {
  const dataPath = dataFilePath(vaultDir);
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  const passphrase = configPassphrase(data);
  const activeRemoteId = data.activeConfigurationId;
  const remoteConfigurations = data.remoteConfigurations ?? {};
  if (typeof activeRemoteId !== 'string' || !remoteConfigurations[activeRemoteId]) {
    throw new Error('no active remote configuration');
  }
  const remoteUri = await decryptValue(remoteConfigurations[activeRemoteId].uri, passphrase);
  return {
    dataPath,
    data,
    e2eePassphrase: await decryptValue(data.encryptedPassphrase, passphrase),
    idDerivationKey: await decryptValue(data.encryptedIdDerivationKey, passphrase),
    idDerivationVersion: Number.isInteger(data.idDerivationVersion) ? data.idDerivationVersion : 0,
    legacyConnection: JSON.parse(await decryptValue(data.encryptedCouchDBConnection, passphrase)),
    activeRemoteId,
    remoteUri,
    remote: parseRemote(remoteUri),
  };
}

export async function writeVault(vaultDir, data) {
  const dataPath = dataFilePath(vaultDir);
  const temporary = `${dataPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, dataPath);
}
