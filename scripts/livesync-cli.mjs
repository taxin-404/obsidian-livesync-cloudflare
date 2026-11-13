import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readVault } from './livesync-config.mjs';

const OBSIDIAN_PROCESSES = [
  ['-f', 'app.asar'],
  ['-x', 'obsidian'],
  ['-x', 'Obsidian'],
];

export const DEFAULT_PASSWORD_FILE =
  process.env.LIVESYNC_PASSWORD_FILE ?? join(homedir(), '.config', 'obsidian-livesync', 'server-password');

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
export function createAdapters(vaultDir) {
  let cached;
  const vault = () => (cached ??= readVault(vaultDir));
  const origin = async () => `https://${(await vault()).remote.host}`;

  return {
    obsidianRunning() {
      return OBSIDIAN_PROCESSES.some((args) => spawnSync('pgrep', args, { stdio: 'ignore' }).status === 0);
    },
    async fetchPage(password) {
      const response = await fetch(`${await origin()}/`, {
        method: 'POST',
        headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password }).toString(),
      });
      return response.text();
    },
    async fetchAuth(password) {
      const state = await vault();
      const response = await fetch(`${await origin()}${databasePath(state.remote)}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${state.remote.user}:${password}`).toString('base64')}`,
        },
      });
      return response.status;
    },
  };
}

export function createSecretPutter(worker, accountId) {
  const env = accountId ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } : process.env;
  return async (name, value) => {
    const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--name', worker], {
      input: `${value}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
      encoding: 'utf8',
      env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const hint = accountId
        ? ''
        : ' — with more than one Cloudflare account, set CLOUDFLARE_ACCOUNT_ID or pass --account-id';
      throw new Error(`wrangler secret put ${name} exited with status ${result.status}${hint}`);
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
