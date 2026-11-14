import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function deploymentConfig(text, environment = '', { noR2 = false } = {}) {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const selected = environment ? config.env?.[environment] : config;
  if (!selected) throw new Error(`Missing deployment environment: ${environment}`);
  const enabled = selected.vars?.BACKUP_ENABLED;
  if (!noR2 && enabled !== 'true' && enabled !== 'false') {
    throw new Error('Set BACKUP_ENABLED to the string "true" or "false" in the selected configuration.');
  }
  if (!noR2 && enabled === 'true') return null;
  selected.vars = { ...(selected.vars ?? {}), BACKUP_ENABLED: 'false' };
  selected.r2_buckets = (selected.r2_buckets ?? []).filter(bucket => bucket.binding !== 'BACKUP_BUCKET');
  // An empty list removes deployed cron triggers; omitting it leaves them running.
  selected.triggers = { ...selected.triggers, crons: [] };
  return config;
}

export function backupsRequested(text, environment = '') {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const selected = environment ? config.env?.[environment] : config;
  if (!selected) throw new Error(`Missing deployment environment: ${environment}`);
  const enabled = selected.vars?.BACKUP_ENABLED;
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('Set BACKUP_ENABLED to the string "true" or "false" in the selected configuration.');
  }
  return enabled === 'true';
}

function summarize(output) {
  const lines = output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line
      && !/wrangler \d/i.test(line)
      && !/update available/i.test(line)
      && !/^[─\s]+$/.test(line)
      && !/^(listing buckets|getting user settings)/i.test(line),
    );
  return lines[0] || 'unknown error';
}

const R2_ABORT_PATTERN =
  /multiple accounts|more than one account|account_id|not authenticated|authentication|fetch failed|ENOTFOUND|ECONN/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function resolveBackupMode({
  requested,
  noR2 = false,
  requireR2 = false,
  probeR2,
  retryDelayMs = 1500,
  sleep = defaultSleep,
}) {
  if (noR2 && requireR2) throw new Error('Use either --no-r2 or --require-r2, not both.');
  if (noR2) return { noR2: true, notice: null };
  if (!requested) return { noR2: true, notice: null };
  let result = await probeR2();
  if (!result.ok) {
    await sleep(retryDelayMs);
    result = await probeR2();
  }
  if (result.ok) return { noR2: false, notice: 'R2 is available — deploying with backups.' };
  const detail = summarize(result.output);
  if (requireR2) throw new Error(`R2 is required but not available: ${detail}`);
  if (R2_ABORT_PATTERN.test(result.output)) throw new Error(`Cannot check R2: ${detail}`);
  return {
    noR2: true,
    notice: `R2 is not available on this account (${detail}).\nDeploying without backups. The bucket and its data are untouched; the next deploy restores backups once R2 is enabled.`,
  };
}

export function deployArgs(argv) {
  const [configPath, environment, ...args] = argv;
  if (!configPath || environment === undefined) {
    throw new Error('Usage: deploy-storage.mjs CONFIG ENV [--no-r2 | --require-r2] [Wrangler deploy options]');
  }
  if (args.some(arg => /^(--config|--env|--var|-c|-e)(=|$)/.test(arg))) {
    throw new Error('Set configuration, environment and variables in the deployment config, not extra Wrangler options.');
  }
  return {
    configPath,
    environment,
    noR2: args.includes('--no-r2'),
    requireR2: args.includes('--require-r2'),
    wranglerArgs: args.filter(arg => arg !== '--no-r2' && arg !== '--require-r2'),
  };
}

function wranglerPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
}

function createR2Probe() {
  const wrangler = wranglerPath();
  return () => {
    const result = spawnSync(process.execPath, [wrangler, 'r2', 'bucket', 'list'], { encoding: 'utf8' });
    return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
}

export async function deployStorage(argv, { probeR2 = createR2Probe(), spawn = spawnSync, sleep } = {}) {
  const { configPath, environment, noR2, requireR2, wranglerArgs } = deployArgs(argv);
  const source = resolve(configPath);
  let text;
  try {
    text = readFileSync(source, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `${configPath} is missing. Run "npm run deploy" to deploy wrangler.jsonc, or create ${configPath} with the Worker name, bucket and environment you want.`,
      );
    }
    throw error;
  }
  const requested = noR2 ? false : backupsRequested(text, environment);
  // A dry run bundles without deploying, so it never needs R2 and must stay
  // credential-free (npm run dry-run), unlike a real deploy.
  const mode = wranglerArgs.includes('--dry-run')
    ? { noR2: noR2 || !requested, notice: null }
    : await resolveBackupMode({ requested, noR2, requireR2, probeR2, sleep });
  if (mode.notice) console.log(mode.notice);
  const config = deploymentConfig(text, environment, { noR2: mode.noR2 });
  // Keep the copy beside the original so relative entrypoints and secret files still resolve.
  const temporary = config ? join(dirname(source), `.wrangler-deploy-${randomUUID()}.jsonc`) : null;
  const wrangler = wranglerPath();
  try {
    if (temporary) writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    const result = spawn(process.execPath, [wrangler, 'deploy', '--config', temporary ?? source, '--env', environment, ...wranglerArgs], { stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await deployStorage(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
