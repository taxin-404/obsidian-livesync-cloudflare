import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readVault } from './livesync-config.mjs';

// Obsidian ships as an Electron app, so on Linux the process is usually called
// `electron` and only its command line names Obsidian. Match the executable and
// the app bundle, never a generic `app.asar` that would catch other editors.
const OBSIDIAN_PROCESSES = [
  ['-x', 'obsidian'],
  ['-x', 'Obsidian'],
  ['-f', '/obsidian/app.asar'],
];

const REQUEST_TIMEOUT_MS = 15_000;

export const DEFAULT_PASSWORD_FILE =
  process.env.LIVESYNC_PASSWORD_FILE ?? join(homedir(), '.config', 'obsidian-livesync', 'server-password');

export const DEFAULT_PAGE_PASSWORD_FILE =
  process.env.LIVESYNC_PAGE_PASSWORD_FILE ?? join(homedir(), '.config', 'obsidian-livesync', 'page-password');

/**
 * Reads an optional secret file. A separate page password is optional, so a
 * missing file is normal and never an error.
 */
export async function readSecretFile(path) {
  if (!path) return '';
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

export function flagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function databasePath(remote) {
  const database = new URLSearchParams(remote.search ?? '').get('db');
  if (database) return `/${encodeURIComponent(database)}`;
  return remote.pathname && remote.pathname !== '/' ? remote.pathname : '/';
}

/**
 * Real adapters for the two commands: the HTTP surface comes from the vault's
 * own remote configuration, so nothing is hard-coded.
 */
export function isObsidianRunning() {
  return OBSIDIAN_PROCESSES.some((args) => spawnSync('pgrep', args, { stdio: 'ignore' }).status === 0);
}

export function createAdapters(vaultDir) {
  let cached;
  const vault = () => (cached ??= readVault(vaultDir));
  const origin = async () => `https://${(await vault()).remote.host}`;

  return {
    obsidianRunning() {
      return isObsidianRunning();
    },
    async fetchPage(password) {
      const response = await fetch(`${await origin()}/`, {
        method: 'POST',
        headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.text();
    },
    async fetchAuth(password) {
      const state = await vault();
      const response = await fetch(`${await origin()}${databasePath(state.remote)}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${state.remote.user}:${password}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.status;
    },
  };
}

/**
 * Turns a failed preflight into one sentence the operator can act on. Wrangler
 * reports an ambiguous account separately from a missing Worker, and the two
 * need different fixes.
 */
export function preflightFailure(worker, stderr = '') {
  if (/more than one account/i.test(stderr)) {
    return 'Wrangler can see more than one Cloudflare account — pass --account-id <id> or set CLOUDFLARE_ACCOUNT_ID; nothing was changed';
  }
  return `Worker "${worker}" is not reachable in this account — pass --worker <name> or set CLOUDFLARE_ACCOUNT_ID; nothing was changed`;
}

export function createSecretPutter(worker, accountId) {
  const env = accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env;
  let checked = false;

  const requireWorker = () => {
    if (checked) return;
    const result = spawnSync('npx', ['wrangler', 'secret', 'list', '--name', worker], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(preflightFailure(worker, result.stderr));
    checked = true;
  };

  return async (name, value) => {
    requireWorker();
    const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--name', worker], {
      input: `${value}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
      env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`wrangler secret put ${name} exited with status ${result.status} (see the output above)`);
    }
  };
}

export function printSteps(steps) {
  for (const step of steps) console.log(`- ${step}`);
}

export function printReport(report) {
  const width = Math.max(...report.links.map((link) => link.name.length));
  for (const link of report.links) {
    console.log(`${link.name.padEnd(width)}  ${link.ok ? 'ok  ' : 'FAIL'}  ${link.detail}`);
  }
}
