import { readFile, rename, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import {
  buildProfile,
  configPassphrase,
  decodeSetupUri,
  encryptValue,
  formatRemote,
  readSetupPage,
  readVault,
  writeVault,
} from './livesync-config.mjs';

const crypto = globalThis.crypto ?? webcrypto;
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_LENGTH = 28;
const SETUP_PASSPHRASE_BYTES = 24;

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function randomFromAlphabet(alphabet, length, random) {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generatePassword(random = randomBytes) {
  return randomFromAlphabet(PASSWORD_ALPHABET, PASSWORD_LENGTH, random);
}

export function generateSetupPassphrase(random = randomBytes) {
  return Buffer.from(random(SETUP_PASSPHRASE_BYTES)).toString('base64url');
}

async function writePasswordFile(passwordFile, password) {
  const temporary = `${passwordFile}.tmp`;
  await writeFile(temporary, `${password}\n`, { mode: 0o600 });
  await rename(temporary, passwordFile);
}

async function writeRotatedVault(vaultDir, state, password) {
  const passphrase = configPassphrase(state.data);
  const active = state.data.remoteConfigurations[state.activeRemoteId];
  const data = structuredClone(state.data);
  data.encryptedPassphrase = await encryptValue(state.e2eePassphrase, passphrase);
  data.encryptedIdDerivationKey = await encryptValue(state.idDerivationKey, passphrase);
  data.encryptedCouchDBConnection = await encryptValue(
    JSON.stringify({
      ...state.legacyConnection,
      couchDB_URI: `https://${state.remote.host}`,
      couchDB_USER: state.remote.user,
      couchDB_DBNAME: databaseName(state.remote, state),
      couchDB_PASSWORD: password,
    }),
    passphrase,
  );
  data.remoteConfigurations[state.activeRemoteId] = {
    ...active,
    uri: await encryptValue(formatRemote({ ...state.remote, password }), passphrase),
    isEncrypted: true,
  };
  await writeVault(vaultDir, data);
}

function databaseName(remote, state) {
  return new URLSearchParams(remote.search ?? '').get('db') || state.legacyConnection?.couchDB_DBNAME || 'vault';
}

function buildSteps({ state, passwordFile, dryRun }) {
  const database = databaseName(state.remote, state);
  const lines = [
    `${dryRun ? 'Dry run — nothing was changed.' : 'Rotated.'} Target: ${state.remote.host}, database ${database}, user ${state.remote.user}.`,
    dryRun ? 'A real run would push COUCHDB_PASSWORD, SETUP_URI and SETUP_URI_PASSPHRASE, then verify all three.' : 'Pushed and verified COUCHDB_PASSWORD, SETUP_URI and SETUP_URI_PASSPHRASE.',
    'Phone or other device: open LiveSync → Remote configuration → import the setup URI and passphrase shown on the gated page. Every paired device must re-pair; the old password stops working immediately.',
    'Desktop: quit and reopen Obsidian, then wait for "↑ 0 ↓ 0" before editing.',
    dryRun
      ? `A real run would rewrite ${passwordFile} (mode 0600) and the vault's LiveSync data.json.`
      : `The new server password is in ${passwordFile} (mode 0600); the vault's LiveSync data.json now carries it encrypted.`,
  ];
  if (!dryRun) lines.push('Verify with: npm run check:secrets -- --vault <path>');
  return lines;
}

async function verifyDeployment({ fetchAuth, fetchPage, previousPassword, password, setupUri }) {
  const newStatus = await fetchAuth(password);
  if (newStatus !== 200) throw new Error(`the server rejected the new password (status ${newStatus})`);
  const oldStatus = await fetchAuth(previousPassword);
  if (oldStatus !== 401) throw new Error('old password still authenticates — COUCHDB_PASSWORD was not replaced');
  const html = await fetchPage(password);
  const { uri } = readSetupPage(html);
  if (uri !== setupUri) throw new Error('the gate page served a different setup URI');
}

/**
 * Restores every secret this run managed to replace, newest first, so a failed
 * rotation leaves the deployment usable with the old credentials. Returns a
 * sentence to append to the failure message.
 */
async function rollBack({ putSecret, pushed, previous }) {
  const failures = [];
  for (const name of pushed.slice().reverse()) {
    try {
      await putSecret(name, previous[name]);
    } catch (error) {
      failures.push(`${name} (${error.message})`);
    }
  }
  if (failures.length === 0) {
    return ' — the old secrets were restored, no local file was written; fix the cause and re-run';
  }
  return ` — restoring ${failures.join(', ')} failed, so the deployment is partially rotated; re-run once it is reachable`;
}

/**
 * One run moves the server password, the setup URI, the setup passphrase, the
 * local password file and the vault's encrypted connection together. Nothing
 * local is written until the server has accepted all three secrets.
 */
export async function rotate(options) {
  const {
    vaultDir,
    passwordFile,
    putSecret,
    fetchPage,
    fetchAuth,
    obsidianRunning = () => false,
    random = randomBytes,
    dryRun = false,
    force = false,
  } = options;

  if (obsidianRunning() && !force) {
    throw new Error('Obsidian is running — quit it first, or re-run with --force (the plugin rewrites data.json from memory)');
  }

  const state = await readVault(vaultDir);
  const previousPassword = (await readFile(passwordFile, 'utf8')).trim();
  if (!previousPassword) throw new Error(`password file is empty: ${passwordFile}`);
  if (state.remote.password !== previousPassword) {
    throw new Error('vault password and password file disagree — run check:secrets');
  }

  const password = generatePassword(random);
  const setupPassphrase = generateSetupPassphrase(random);

  const html = await fetchPage(previousPassword);
  const { uri: currentUri, passphrase: currentPassphrase } = readSetupPage(html);
  const profile = await decodeSetupUri(currentUri, currentPassphrase);

  const built = await buildProfile({
    profile,
    remote: {
      ...state.remote,
      name: state.data.remoteConfigurations[state.activeRemoteId].name,
    },
    password,
    e2eePassphrase: state.e2eePassphrase,
    idDerivationKey: state.idDerivationKey,
    idDerivationVersion: state.idDerivationVersion,
    setupPassphrase,
    random,
  });

  const decoded = await decodeSetupUri(built.uri, setupPassphrase);
  if (JSON.stringify(decoded) !== JSON.stringify(built.settings)) {
    throw new Error('the new setup URI did not survive its own round trip');
  }

  const steps = buildSteps({ state, passwordFile, dryRun });
  if (dryRun) return { password, setupUri: built.uri, setupPassphrase, steps, dryRun: true };

  const pushed = [];
  try {
    for (const [name, value] of [
      ['COUCHDB_PASSWORD', password],
      ['SETUP_URI', built.uri],
      ['SETUP_URI_PASSPHRASE', setupPassphrase],
    ]) {
      try {
        await putSecret(name, value);
      } catch (error) {
        throw new Error(`failed to push ${name}: ${error.message}`);
      }
      pushed.push(name);
    }

    await verifyDeployment({
      fetchAuth,
      fetchPage,
      previousPassword,
      password,
      setupUri: built.uri,
    });
  } catch (error) {
    const rollback = await rollBack({
      putSecret,
      pushed,
      previous: {
        COUCHDB_PASSWORD: previousPassword,
        SETUP_URI: currentUri,
        SETUP_URI_PASSPHRASE: currentPassphrase,
      },
    });
    throw new Error(`${error.message}${rollback}`);
  }

  await writePasswordFile(passwordFile, password);
  await writeRotatedVault(vaultDir, state, password);

  const after = await readVault(vaultDir);
  if (after.remote.password !== password) throw new Error('the vault remote URI did not take the new password');
  if (after.legacyConnection.couchDB_PASSWORD !== password) {
    throw new Error('the legacy connection did not take the new password');
  }
  if (after.e2eePassphrase !== state.e2eePassphrase) throw new Error('the end-to-end passphrase changed unexpectedly');
  if (after.idDerivationKey !== state.idDerivationKey) throw new Error('the ID derivation key changed unexpectedly');

  return { password, setupUri: built.uri, setupPassphrase, steps };
}
