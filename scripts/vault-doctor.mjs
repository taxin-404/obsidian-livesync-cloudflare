import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configPassphrase, dataFilePath, decryptValue, isEncryptedBlob, parseRemote } from './livesync-config.mjs';
import { flagValue } from './livesync-cli.mjs';

const DEFAULT_REGISTRY_PATH =
  process.env.OBSIDIAN_CONFIG ?? join(homedir(), '.config', 'obsidian', 'obsidian.json');

/** The (host, database) pair two vaults share when they sync to the same place. */
function targetOf(remote) {
  const database = new URLSearchParams(remote.search ?? '').get('db');
  const path = (remote.pathname ?? '').replace(/^\/+|\/+$/g, '');
  return `${remote.host}/${database || path}`;
}

/**
 * Reads one vault's plugin data.json directly — never `readVault`, which rejects
 * a vault whose `activeConfigurationId` is empty even though it still syncs.
 */
async function inspectVault(vaultDir) {
  const dir = resolve(vaultDir);
  const name = basename(dir);
  try {
    const data = JSON.parse(await readFile(dataFilePath(dir), 'utf8'));
    const passphrase = configPassphrase(data);
    const targets = new Set();

    for (const entry of Object.values(data.remoteConfigurations ?? {})) {
      try {
        const uri = isEncryptedBlob(entry?.uri) ? await decryptValue(entry.uri, passphrase) : entry?.uri;
        if (typeof uri === 'string') targets.add(targetOf(parseRemote(uri)));
      } catch {
        // An unreadable remote entry must not stop the scan of the others.
      }
    }

    // The legacy connection is a fallback: a vault that migrated to
    // remoteConfigurations uses those, and the stale legacy field would only
    // add a second target for the same remote.
    if (targets.size === 0 && typeof data.encryptedCouchDBConnection === 'string' && data.encryptedCouchDBConnection.length > 0) {
      try {
        const blob = data.encryptedCouchDBConnection;
        const legacy = JSON.parse(isEncryptedBlob(blob) ? await decryptValue(blob, passphrase) : blob);
        targets.add(`${new URL(legacy.couchDB_URI).host}/${legacy.couchDB_DBNAME ?? ''}`);
      } catch {
        // An unreadable legacy connection is skipped, not fatal.
      }
    }

    return {
      name,
      dir,
      liveSync: data.liveSync === true,
      activeConfigurationId: typeof data.activeConfigurationId === 'string' ? data.activeConfigurationId : '',
      targets: [...targets].sort(),
    };
  } catch (error) {
    return { name, dir, liveSync: false, activeConfigurationId: '', targets: [], error: error.message };
  }
}

/**
 * Scans the given vault directories and reports every (host, database) target
 * used by more than one vault. Read-only: it never edits a vault.
 */
export async function doctorVaults(vaultDirs) {
  const vaults = [];
  for (const dir of vaultDirs) vaults.push(await inspectVault(dir));

  const byTarget = new Map();
  for (const vault of vaults) {
    for (const target of vault.targets) {
      const names = byTarget.get(target) ?? new Set();
      names.add(vault.name);
      byTarget.set(target, names);
    }
  }

  const collisions = [];
  for (const [target, names] of byTarget) {
    if (names.size > 1) collisions.push({ target, vaults: [...names] });
  }

  const ok = collisions.length === 0;
  return { ok, exitCode: ok ? 0 : 1, vaults, collisions };
}

async function registryVaults(registryPath) {
  try {
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    return Object.values(registry?.vaults ?? {})
      .map((vault) => vault?.path)
      .filter((path) => typeof path === 'string');
  } catch {
    return [];
  }
}

async function rootVaults(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

/**
 * Unions the explicit vaults, one level under each root, and the vaults the
 * Obsidian registry knows about, keeping only paths that actually hold a
 * LiveSync `data.json`. Discovery never throws.
 */
export async function discoverVaults({ vaults = [], roots = [], registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  const candidates = [...vaults];
  for (const root of roots) {
    candidates.push(root);
    candidates.push(...(await rootVaults(root)));
  }
  candidates.push(...(await registryVaults(registryPath)));

  const found = new Set();
  for (const candidate of candidates) {
    try {
      const dir = resolve(candidate);
      await access(dataFilePath(dir));
      found.add(dir);
    } catch {
      // Not a vault, or gone since the registry was written.
    }
  }
  return [...found];
}

export function parseArgs(argv) {
  const args = { vaults: [], roots: [], json: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--vault') {
      args.vaults.push(flagValue(argv, index, flag));
      index++;
    } else if (flag === '--root') {
      args.roots.push(flagValue(argv, index, flag));
      index++;
    } else if (flag === '--json') {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function printReport(report) {
  if (report.vaults.length === 0) {
    console.log('No Obsidian vaults with the LiveSync plugin were found.');
    return;
  }
  const width = Math.max(...report.vaults.map((vault) => vault.name.length));
  for (const vault of report.vaults) {
    const state = vault.liveSync ? 'sync on' : 'sync off';
    const detail = vault.error ? `could not be read: ${vault.error}` : vault.targets.join(', ') || '(no remote)';
    console.log(`${vault.name.padEnd(width)}  ${state}  ${detail}`);
  }
  if (report.collisions.length === 0) {
    console.log('\nNo two vaults share a sync target.');
    return;
  }
  for (const collision of report.collisions) {
    console.log(`\nCollision: ${collision.vaults.join(', ')} all sync to ${collision.target}.`);
    console.log('Keep one vault on that target and turn LiveSync off in the others; nothing was changed.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = await discoverVaults({ vaults: args.vaults, roots: args.roots });
  const report = await doctorVaults(dirs);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
