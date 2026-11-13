import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encryptValue, DEFAULT_CONFIG_PASSPHRASE } from '../../scripts/livesync-config.mjs';

export const LEGACY_TEMPLATE = {
  couchDB_URI: 'https://host.test',
  couchDB_USER: 'admin',
  couchDB_PASSWORD: 'old',
  couchDB_DBNAME: 'vault',
  couchDB_CustomHeaders: '',
  jwtKey: '',
  jwtKid: '',
  jwtSub: '',
  accessKey: '',
  secretKey: '',
  bucket: '',
  region: 'auto',
  endpoint: '',
  bucketCustomHeaders: '',
};

/**
 * Writes a throwaway vault with the plugin's encrypted fields already in place.
 * Everything is generated per call, so no real secret is ever part of a fixture.
 */
export async function makeVault(options = {}) {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'livesync-vault-'));
  const pluginDir = path.join(vaultDir, '.obsidian', 'plugins', 'obsidian-livesync');
  await mkdir(pluginDir, { recursive: true });
  const password = options.password ?? 'previous-secret-1';
  const e2eePassphrase = options.e2eePassphrase ?? 'e'.repeat(64);
  const idDerivationKey = options.idDerivationKey ?? 'a'.repeat(64);
  const remoteProduct = `sls+https://admin:${password}@host.test/?db=vault`;
  const data = {
    remoteType: '',
    liveSync: true,
    encrypt: true,
    configPassphraseStore: '',
    encryptedPassphrase: await encryptValue(e2eePassphrase, DEFAULT_CONFIG_PASSPHRASE),
    encryptedIdDerivationKey: await encryptValue(idDerivationKey, DEFAULT_CONFIG_PASSPHRASE),
    encryptedCouchDBConnection: await encryptValue(JSON.stringify({ ...LEGACY_TEMPLATE, couchDB_PASSWORD: password }), DEFAULT_CONFIG_PASSPHRASE),
    remoteConfigurations: {
      'remote-test': {
        id: 'remote-test',
        name: 'test',
        uri: options.storedRemoteUri ?? await encryptValue(options.remoteProduct ?? remoteProduct, DEFAULT_CONFIG_PASSPHRASE),
        isEncrypted: true,
      },
    },
    activeConfigurationId: options.activeConfigurationId ?? 'remote-test',
    idDerivationVersion: 1,
  };
  const dataPath = path.join(pluginDir, 'data.json');
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  const passwordFile = path.join(vaultDir, 'server-password');
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  return { vaultDir, dataPath, passwordFile, password, e2eePassphrase, idDerivationKey, remoteProduct: options.remoteProduct ?? remoteProduct };
}

export async function readDataFile(vault) {
  return readFile(vault.dataPath, 'utf8');
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Returns a plain description of every file the tooling may touch. */
export async function snapshot(vault) {
  return {
    data: await readDataFile(vault),
    password: await readFile(vault.passwordFile, 'utf8'),
    dataTemp: await readOptional(`${vault.dataPath}.tmp`),
    passwordTemp: await readOptional(`${vault.passwordFile}.tmp`),
  };
}

/** Deterministic random source so generated ids and salts are reproducible. */
export function fixedRandom(seed = 1) {
  let state = seed >>> 0;
  return (bytes) => {
    const out = new Uint8Array(bytes);
    for (let index = 0; index < bytes; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[index] = state & 0xff;
    }
    return out;
  };
}

/** A throwaway account whose local files are a fresh fixture vault. */
export async function fixture(overrides = {}) {
  const vault = await makeVault();
  return {
    vaultDir: vault.vaultDir,
    dataPath: vault.dataPath,
    passwordFile: vault.passwordFile,
    password: vault.password,
    e2eePassphrase: vault.e2eePassphrase,
    idDerivationKey: vault.idDerivationKey,
    worker: 'live',
    accountId: 'test',
    obsidianRunning: () => false,
    random: fixedRandom(),
    ...overrides,
  };
}

/** The new-device profile the setup page serves. */
export function profileFor({ password = 'previous-secret-1', e2eePassphrase = 'e'.repeat(64), idDerivationKey = 'a'.repeat(64) } = {}) {
  return {
    couchDB_URI: 'https://host.test',
    couchDB_USER: 'admin',
    couchDB_PASSWORD: password,
    couchDB_DBNAME: 'vault',
    encrypt: true,
    usePathObfuscation: true,
    encryptInternalMetadata: true,
    passphrase: e2eePassphrase,
    idDerivationVersion: 1,
    idDerivationKey,
    configPassphraseStore: '',
    encryptedPassphrase: '',
    encryptedCouchDBConnection: '',
    remoteConfigurations: {
      'remote-page': {
        id: 'remote-page',
        name: 'CouchDB host.test',
        uri: `sls+https://admin:${password}@host.test/?db=vault`,
        isEncrypted: false,
      },
    },
  };
}

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The gated page fragment the tooling reads: one URI and one passphrase. */
export function pageHtml(uri, passphrase = 'old-uri-pass') {
  return `<!doctype html><html><body><dl><dd id="v-uri">${escapeHtml(uri)}</dd><dd id="v-pass">${escapeHtml(passphrase)}</dd></dl></body></html>`;
}
