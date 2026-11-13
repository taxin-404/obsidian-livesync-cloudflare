import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { decodeSetupUri, parseRemote, readSetupPage, readVault } from './livesync-config.mjs';
import { createAdapters, DEFAULT_PASSWORD_FILE, flagValue, printReport } from './livesync-cli.mjs';

const link = (name, ok, detail) => ({ name, ok, detail });

async function readPassword(passwordFile) {
  try {
    return (await readFile(passwordFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
}

function databaseOf(remote) {
  return new URLSearchParams(remote.search ?? '').get('db') ?? '';
}

function remoteEntry(profile) {
  const entries = Object.values(profile?.remoteConfigurations ?? {});
  return entries.length === 1 ? entries[0] : null;
}

/**
 * Compares the live deployment with the local vault and names the link that
 * drifted. Every detail is safe to print: no password, passphrase, key or URI
 * ever reaches it.
 */
export async function checkSecrets({ vaultDir, passwordFile, fetchPage, fetchAuth }) {
  const password = await readPassword(passwordFile);

  let state = null;
  let vaultError = null;
  try {
    state = await readVault(vaultDir);
  } catch (error) {
    vaultError = error;
  }

  const links = [];

  let status = null;
  let authError = null;
  try {
    status = await fetchAuth(password);
  } catch (error) {
    authError = error;
  }
  links.push(
    link(
      'server password',
      status === 200,
      authError
        ? `the server could not be reached: ${authError.message}`
        : status === 200
          ? 'the saved password authenticates against the vault'
          : `the server rejected the saved password (status ${status})`,
    ),
  );

  let page = null;
  let pageError = null;
  if (!password) {
    pageError = new Error('the password file is empty or missing');
  } else {
    try {
      page = readSetupPage(await fetchPage(password));
    } catch (error) {
      pageError = error;
    }
  }

  let profile = null;
  let decodeError = null;
  if (page) {
    try {
      profile = await decodeSetupUri(page.uri, page.passphrase);
    } catch (error) {
      decodeError = error;
    }
  }
  links.push(
    link(
      'setup page gate',
      profile !== null,
      pageError
        ? pageError.message
        : decodeError
          ? 'the setup URI did not decrypt with the passphrase shown on the page'
          : 'the page served a setup URI and the shown passphrase decrypted it',
    ),
  );

  const storedRemote = remoteEntry(profile);
  let storedRemotePassword = null;
  let remoteError = null;
  if (storedRemote && storedRemote.isEncrypted === false) {
    try {
      storedRemotePassword = parseRemote(storedRemote.uri).password;
    } catch {
      remoteError = 'the setup URI carries a remote entry that cannot be read';
    }
  }
  const passwordMatches =
    profile !== null && profile.couchDB_PASSWORD === password && remoteError === null && (storedRemotePassword === null || storedRemotePassword === password);
  links.push(
    link(
      'setup URI password',
      passwordMatches,
      remoteError
        ? remoteError
        : profile === null
          ? 'the setup URI could not be read, so its password cannot be checked'
          : passwordMatches
            ? 'the setup URI carries the saved password'
            : 'the setup URI carries a different password than the one saved locally',
    ),
  );

  let profileDetail = 'the setup URI keeps the vault end-to-end passphrase, ID derivation key and server address';
  let profileOk = false;
  if (profile === null) {
    profileDetail = 'the setup URI could not be read, so the device profile cannot be checked';
  } else if (state === null) {
    profileDetail = 'the vault could not be read, so the device profile cannot be compared';
  } else if (profile.idDerivationKey !== state.idDerivationKey) {
    profileDetail = 'the setup URI derives file identities with a different ID key — a new device would duplicate the vault';
  } else if (profile.passphrase !== state.e2eePassphrase) {
    profileDetail = 'the setup URI carries a different end-to-end passphrase';
  } else if (profile.idDerivationVersion !== state.idDerivationVersion) {
    profileDetail = 'the setup URI uses a different ID derivation version';
  } else if (hostOf(profile.couchDB_URI) !== state.remote.host) {
    profileDetail = `the setup URI points at ${hostOf(profile.couchDB_URI) || 'an unreadable address'}, expected ${state.remote.host}`;
  } else if (profile.couchDB_USER !== state.remote.user) {
    profileDetail = `the setup URI uses the user ${profile.couchDB_USER}, expected ${state.remote.user}`;
  } else if (profile.couchDB_DBNAME !== databaseOf(state.remote)) {
    profileDetail = `the setup URI uses the database ${profile.couchDB_DBNAME}, expected ${databaseOf(state.remote)}`;
  } else {
    profileOk = true;
  }
  links.push(link('setup URI device profile', profileOk, profileDetail));

  let vaultDetail;
  let vaultOk = false;
  if (vaultError) {
    vaultDetail = `the vault could not be read: ${vaultError.message}`;
  } else if (state.remote.password !== password) {
    vaultDetail = "the vault's remote configuration carries a different password than the one saved locally";
  } else if (state.legacyConnection.couchDB_PASSWORD !== password) {
    vaultDetail = "the vault's legacy connection carries a different password than the one saved locally";
  } else {
    vaultOk = true;
    vaultDetail = "the vault's remote configuration and legacy connection carry the saved password";
  }
  links.push(link('vault connection', vaultOk, vaultDetail));

  const ok = links.every((entry) => entry.ok);
  return { ok, links, exitCode: ok ? 0 : 1 };
}

export function parseArgs(argv) {
  const args = { vault: '', json: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--vault') {
      args.vault = flagValue(argv, index, flag);
      index++;
    } else if (flag === '--password-file') {
      args.passwordFile = flagValue(argv, index, flag);
      index++;
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
  const report = await checkSecrets({
    vaultDir: args.vault,
    passwordFile: args.passwordFile ?? DEFAULT_PASSWORD_FILE,
    fetchPage: adapters.fetchPage,
    fetchAuth: adapters.fetchAuth,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
    if (!report.ok) console.log(`\nFix: npm run rotate:password -- --vault ${args.vault}`);
  }
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
