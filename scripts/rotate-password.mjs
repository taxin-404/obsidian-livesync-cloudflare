import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildProfile,
  configPassphrase,
  decodeSetupUri,
  encryptValue,
  formatRemote,
  readSetupPage,
  readVault,
  serializeVault,
} from './livesync-config.mjs';
import { createAdapters, createSecretPutter, DEFAULT_PASSWORD_FILE, flagValue, printSteps } from './livesync-cli.mjs';

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

function databaseName(remote, state) {
  return new URLSearchParams(remote.search ?? '').get('db') || state.legacyConnection?.couchDB_DBNAME || 'vault';
}

async function buildRotatedData(state, password) {
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
  return data;
}

async function discardFiles(paths) {
  for (const path of paths) {
    try {
      await rm(path, { force: true });
    } catch {
      // A left-over temporary file is better than a failed rotation.
    }
  }
}

/**
 * Writes both local outputs next to their targets, already 0600, before the
 * first secret is pushed. A failure at any later step can therefore discard
 * them without touching the files the plugin and the tools read.
 */
async function stageLocalFiles({ state, passwordFile, password }) {
  const passwordTemporary = `${passwordFile}.tmp`;
  const vaultTemporary = `${state.dataPath}.tmp`;
  try {
    const data = await buildRotatedData(state, password);
    await writeFile(passwordTemporary, `${password}\n`, { mode: 0o600 });
    await chmod(passwordTemporary, 0o600);
    await writeFile(vaultTemporary, serializeVault(data), { mode: 0o600 });
    await chmod(vaultTemporary, 0o600);
    return { passwordTemporary, vaultTemporary };
  } catch (error) {
    await discardFiles([passwordTemporary, vaultTemporary]);
    throw new Error(`could not stage the local files (${error.message}) — the server was not changed`);
  }
}

async function commitStaged({ staged, state, passwordFile }) {
  try {
    await rename(staged.passwordTemporary, passwordFile);
  } catch (error) {
    throw new Error(
      `the server is rotated but the password file could not be replaced (${error.message}); the new password is in ${staged.passwordTemporary} — move it to ${passwordFile} before syncing again`,
    );
  }
  try {
    await rename(staged.vaultTemporary, state.dataPath);
  } catch (error) {
    throw new Error(
      `the server and the password file are rotated but the vault settings could not be replaced (${error.message}); the encrypted settings are in ${staged.vaultTemporary} — move it over ${state.dataPath} before syncing again`,
    );
  }
}

function buildSteps({ state, passwordFile, dryRun }) {
  const database = databaseName(state.remote, state);
  const lines = [
    `${dryRun ? 'Dry run — nothing was changed.' : 'Rotated.'} Target: ${state.remote.host}, database ${database}, user ${state.remote.user}.`,
    dryRun
      ? 'A real run would stage the local files, push and verify SETUP_URI and SETUP_URI_PASSPHRASE, then push and verify COUCHDB_PASSWORD.'
      : 'Staged the local files, pushed and verified SETUP_URI and SETUP_URI_PASSPHRASE, then pushed and verified COUCHDB_PASSWORD.',
    'Phone or other device: open LiveSync → Remote configuration → import the setup URI and passphrase shown on the gated page. Every paired device must re-pair; the old password stops working immediately.',
    'Desktop: quit and reopen Obsidian, then wait for "↑ 0 ↓ 0" before editing.',
    dryRun
      ? `A real run would rewrite ${passwordFile} (mode 0600) and the vault's LiveSync data.json.`
      : `The new server password is in ${passwordFile} (mode 0600); the vault's LiveSync data.json now carries it encrypted.`,
  ];
  if (!dryRun) {
    lines.push(
      `If a run is ever interrupted, look for ${passwordFile}.tmp and ${state.dataPath}.tmp before retrying: one of them may hold the new password and settings.`,
      'Verify with: npm run check:secrets -- --vault <path>',
    );
  }
  return lines;
}

async function verifyPage({ fetchPage, password, setupUri, setupPassphrase, newPassword }) {
  const { uri, passphrase } = readSetupPage(await fetchPage(password));
  if (uri !== setupUri) throw new Error('the gate page did not serve the rotated setup URI');
  if (passphrase !== setupPassphrase) throw new Error('the gate page did not serve the rotated setup passphrase');
  const served = await decodeSetupUri(uri, passphrase);
  if (served.couchDB_PASSWORD !== newPassword) throw new Error('the served setup URI does not carry the new password');
}

async function verifyNewPassword({ fetchAuth, fetchPage, previousPassword, password, setupUri, setupPassphrase }) {
  const newStatus = await fetchAuth(password);
  if (newStatus !== 200) throw new Error(`the server rejected the new password (status ${newStatus})`);
  const oldStatus = await fetchAuth(previousPassword);
  if (oldStatus !== 401) throw new Error('old password still authenticates — COUCHDB_PASSWORD was not replaced');
  await verifyPage({ fetchPage, password, setupUri, setupPassphrase, newPassword: password });
}

/**
 * Restores every secret this run managed to replace, newest first, so a failed
 * rotation leaves the deployment usable with the old credentials. Returns a
 * sentence to append to the failure message.
 */
async function rollBack({ putSecret, pushed, previous, passwordFile }) {
  if (pushed.length === 0) return ' — nothing was changed';
  const failures = [];
  for (const name of pushed.slice().reverse()) {
    try {
      await putSecret(name, previous[name]);
    } catch (error) {
      failures.push(`${name} (${error.message})`);
    }
  }
  if (failures.length === 0) {
    return ' — the old secrets were restored and no local file was touched; fix the cause and re-run';
  }
  return ` — restoring ${failures.join(', ')} failed. The server may now require the new password while ${passwordFile} and the vault hold the old one; restore COUCHDB_PASSWORD, SETUP_URI and SETUP_URI_PASSPHRASE in the Cloudflare dashboard, then re-run.`;
}

/**
 * One run moves the setup URI, the setup passphrase, the server password, the
 * local password file and the vault's encrypted connection together. The local
 * outputs are staged before the first push and only renamed into place after
 * the server has accepted and verified everything.
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
  let page;
  try {
    page = readSetupPage(html);
  } catch (error) {
    throw new Error(
      `${error.message} — the gate password must be COUCHDB_PASSWORD (leave PAGE_PASSWORD unset or set it to the same value)`,
    );
  }
  let profile;
  try {
    profile = await decodeSetupUri(page.uri, page.passphrase);
  } catch {
    throw new Error("the page's passphrase did not decrypt its setup URI");
  }

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

  const staged = await stageLocalFiles({ state, passwordFile, password });

  const pushed = [];
  const push = async (name, value) => {
    try {
      await putSecret(name, value);
    } catch (error) {
      throw new Error(`failed to push ${name}: ${error.message}`);
    }
    pushed.push(name);
  };

  try {
    await push('SETUP_URI', built.uri);
    await push('SETUP_URI_PASSPHRASE', setupPassphrase);

    // The gate still uses the old password here, so this proves the page
    // serves the new pair before the password itself moves.
    await verifyPage({
      fetchPage,
      password: previousPassword,
      setupUri: built.uri,
      setupPassphrase,
      newPassword: password,
    });
    const stillWorks = await fetchAuth(previousPassword);
    if (stillWorks !== 200) {
      throw new Error(`the current password stopped authenticating before the server password changed (status ${stillWorks})`);
    }

    await push('COUCHDB_PASSWORD', password);
    await verifyNewPassword({
      fetchAuth,
      fetchPage,
      previousPassword,
      password,
      setupUri: built.uri,
      setupPassphrase,
    });
  } catch (error) {
    await discardFiles([staged.passwordTemporary, staged.vaultTemporary]);
    const rollback = await rollBack({
      putSecret,
      pushed,
      previous: {
        COUCHDB_PASSWORD: previousPassword,
        SETUP_URI: page.uri,
        SETUP_URI_PASSPHRASE: page.passphrase,
      },
      passwordFile,
    });
    throw new Error(`${error.message}${rollback}`);
  }

  await commitStaged({ staged, state, passwordFile });

  const after = await readVault(vaultDir);
  if (after.remote.password !== password) throw new Error('the vault remote URI did not take the new password');
  if (after.legacyConnection.couchDB_PASSWORD !== password) {
    throw new Error('the legacy connection did not take the new password');
  }
  if (after.e2eePassphrase !== state.e2eePassphrase) throw new Error('the end-to-end passphrase changed unexpectedly');
  if (after.idDerivationKey !== state.idDerivationKey) throw new Error('the ID derivation key changed unexpectedly');

  return { password, setupUri: built.uri, setupPassphrase, steps };
}

export function parseArgs(argv) {
  const args = {
    vault: '',
    worker: process.env.LIVESYNC_WORKER ?? 'live',
    dryRun: false,
    force: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--vault') {
      args.vault = flagValue(argv, index, flag);
      index++;
    } else if (flag === '--worker') {
      args.worker = flagValue(argv, index, flag);
      index++;
    } else if (flag === '--password-file') {
      args.passwordFile = flagValue(argv, index, flag);
      index++;
    } else if (flag === '--account-id') {
      args.accountId = flagValue(argv, index, flag);
      index++;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--force') {
      args.force = true;
    } else if (flag === '--json') {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault) throw new Error('--vault is required, for example --vault ~/Documents/notes');
  const adapters = createAdapters(args.vault);
  const result = await rotate({
    vaultDir: args.vault,
    passwordFile: args.passwordFile ?? DEFAULT_PASSWORD_FILE,
    putSecret: createSecretPutter(args.worker, args.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID),
    fetchPage: adapters.fetchPage,
    fetchAuth: adapters.fetchAuth,
    obsidianRunning: adapters.obsidianRunning,
    dryRun: args.dryRun,
    force: args.force,
  });
  if (args.json) {
    console.log(JSON.stringify({ dryRun: Boolean(args.dryRun), steps: result.steps }, null, 2));
    return;
  }
  printSteps(result.steps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
