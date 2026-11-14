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

export function deployArgs(argv) {
  const [configPath, environment, ...args] = argv;
  if (!configPath || environment === undefined) {
    throw new Error('Usage: deploy-storage.mjs CONFIG ENV [--no-r2] [Wrangler deploy options]');
  }
  if (args.some(arg => /^(--config|--env|--var|-c|-e)(=|$)/.test(arg))) {
    throw new Error('Set configuration, environment and variables in the deployment config, not extra Wrangler options.');
  }
  return {
    configPath,
    environment,
    noR2: args.includes('--no-r2'),
    wranglerArgs: args.filter(arg => arg !== '--no-r2'),
  };
}

export function deployStorage(argv) {
  const { configPath, environment, noR2, wranglerArgs } = deployArgs(argv);
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
  const config = deploymentConfig(text, environment, { noR2 });
  // Keep the copy beside the original so relative entrypoints and secret files still resolve.
  const temporary = config ? join(dirname(source), `.wrangler-deploy-${randomUUID()}.jsonc`) : null;
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  try {
    if (temporary) writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    const result = spawnSync(process.execPath, [wrangler, 'deploy', '--config', temporary ?? source, '--env', environment, ...wranglerArgs], { stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (temporary) rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = deployStorage(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
