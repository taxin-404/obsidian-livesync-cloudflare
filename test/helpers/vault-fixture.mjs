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
  const password = options.password ?? 'old';
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

/** Returns a plain description of every file the tooling may touch. */
export async function snapshot(vault) {
  return { data: await readDataFile(vault), password: await readFile(vault.passwordFile, 'utf8') };
}
