import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { backupsRequested, deployArgs, deploymentConfig, deployStorage, resolveBackupMode } from '../scripts/deploy-storage.mjs';

const template = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('backup deployment flag preserves enabled configs and strips resources only in the selected environment', () => {
  for (const environment of ['', 'dev']) {
    const source = structuredClone(template);
    const selected = environment ? source.env[environment] : source;
    assert.equal(deploymentConfig(JSON.stringify(source), environment), null);
    selected.vars.BACKUP_ENABLED = 'false';
    selected.triggers = { ...selected.triggers, crons: ['0 * * * *'] };
    selected.r2_buckets.push({ binding: 'OTHER_BUCKET', bucket_name: 'keep-me' });
    const text = `// JSONC with trailing comma\n${JSON.stringify(source).replace(/}$/, ',}')}`;
    const result = deploymentConfig(text, environment);
    const expected = structuredClone(source);
    const target = environment ? expected.env[environment] : expected;
    target.r2_buckets = [{ binding: 'OTHER_BUCKET', bucket_name: 'keep-me' }];
    target.triggers.crons = [];
    assert.deepEqual(result, expected);
    assert.equal(selected.r2_buckets[0].binding, 'BACKUP_BUCKET');
    selected.vars.BACKUP_ENABLED = 'true';
    assert.equal(deploymentConfig(JSON.stringify(source), environment), null);
  }
  assert.throws(() => deploymentConfig('{oops'), /./);
  assert.throws(() => deploymentConfig(JSON.stringify(template), 'missing'), /Missing deployment environment/);
  for (const flag of [undefined, false, 'FALSE']) {
    const source = structuredClone(template);
    source.vars.BACKUP_ENABLED = flag;
    assert.throws(() => deploymentConfig(JSON.stringify(source)), /Set BACKUP_ENABLED/);
  }
});

test('no-R2 deployment forces backups off and strips only the backup binding', () => {
  for (const environment of ['', 'dev']) {
    const source = structuredClone(template);
    const selected = environment ? source.env[environment] : source;
    selected.r2_buckets = [...(selected.r2_buckets ?? []), { binding: 'OTHER_BUCKET', bucket_name: 'keep-me' }];
    selected.triggers = { ...selected.triggers, crons: ['0 * * * *'] };
    const result = deploymentConfig(JSON.stringify(source), environment, { noR2: true });
    const expected = structuredClone(source);
    const target = environment ? expected.env[environment] : expected;
    target.vars.BACKUP_ENABLED = 'false';
    target.r2_buckets = target.r2_buckets.filter((bucket) => bucket.binding !== 'BACKUP_BUCKET');
    target.triggers = { ...target.triggers, crons: [] };
    assert.deepEqual(result, expected);
  }
});

test('no-R2 deployment ignores a missing or invalid BACKUP_ENABLED value', () => {
  for (const value of [undefined, false, 'FALSE']) {
    const source = structuredClone(template);
    if (value === undefined) delete source.vars.BACKUP_ENABLED;
    else source.vars.BACKUP_ENABLED = value;
    const result = deploymentConfig(JSON.stringify(source), '', { noR2: true });
    assert.equal(result.vars.BACKUP_ENABLED, 'false');
  }
});

test('parses --no-r2 and --require-r2 out of the Wrangler arguments', () => {
  assert.deepEqual(deployArgs(['wrangler.jsonc', '', '--no-r2', '--dry-run']), {
    configPath: 'wrangler.jsonc',
    environment: '',
    noR2: true,
    requireR2: false,
    wranglerArgs: ['--dry-run'],
  });
  assert.deepEqual(deployArgs(['wrangler.jsonc', 'dev', '--require-r2']), {
    configPath: 'wrangler.jsonc',
    environment: 'dev',
    noR2: false,
    requireR2: true,
    wranglerArgs: [],
  });
  assert.deepEqual(deployArgs(['wrangler.jsonc', 'dev']), {
    configPath: 'wrangler.jsonc',
    environment: 'dev',
    noR2: false,
    requireR2: false,
    wranglerArgs: [],
  });
  assert.throws(() => deployArgs(['wrangler.jsonc', '', '--no-r2', '--var', 'x=1']), /Set configuration/);
  assert.throws(() => deployArgs(['wrangler.jsonc']), /Usage:/);
});

test('reads whether the selected configuration asks for backups', () => {
  assert.equal(backupsRequested(JSON.stringify(template), ''), true);
  assert.equal(backupsRequested(JSON.stringify(template), 'dev'), true);
  for (const environment of ['', 'dev']) {
    const source = structuredClone(template);
    const selected = environment ? source.env[environment] : source;
    selected.vars.BACKUP_ENABLED = 'false';
    assert.equal(backupsRequested(JSON.stringify(source), environment), false);
  }
  for (const value of [undefined, false, 'FALSE']) {
    const source = structuredClone(template);
    if (value === undefined) delete source.vars.BACKUP_ENABLED;
    else source.vars.BACKUP_ENABLED = value;
    assert.throws(() => backupsRequested(JSON.stringify(source), ''), /Set BACKUP_ENABLED/);
  }
  assert.throws(() => backupsRequested(JSON.stringify(template), 'missing'), /Missing deployment environment/);
  assert.throws(() => backupsRequested('{oops', ''), /./);
});

const noSleep = async () => {};
const probeResult = (result) => ({ requested: true, probeR2: async () => result, sleep: noSleep });

test('auto mode keeps backups when the R2 check succeeds', async () => {
  const mode = await resolveBackupMode(probeResult({ ok: true, output: '' }));
  assert.equal(mode.noR2, false);
  assert.match(mode.notice, /R2 is available/);
});

test('auto mode drops backups when the R2 check fails for an R2 reason', async () => {
  const mode = await resolveBackupMode(probeResult({ ok: false, output: 'R2 is not enabled for this account' }));
  assert.equal(mode.noR2, true);
  assert.match(mode.notice, /R2 is not enabled for this account/);
  assert.match(mode.notice, /without backups/);
});

test('auto mode retries the R2 check once before deciding', async () => {
  let calls = 0;
  const probeR2 = async () => {
    calls++;
    return calls === 1 ? { ok: false, output: 'temporary failure' } : { ok: true, output: '' };
  };
  const mode = await resolveBackupMode({ requested: true, probeR2, sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(mode.noR2, false);
});

for (const output of [
  'More than one account available but unable to select one',
  'You are not authenticated.',
  'Authentication error [code: 10000]',
  'fetch failed',
]) {
  test(`auto mode stops for an unusable-account R2 check: ${output}`, async () => {
    await assert.rejects(() => resolveBackupMode(probeResult({ ok: false, output })), /Cannot check R2/);
  });
}

test('auto mode does not check R2 when backups are disabled or forced off', async () => {
  for (const options of [
    { requested: false, probeR2: async () => { throw new Error('must not run'); } },
    { requested: true, noR2: true, probeR2: async () => { throw new Error('must not run'); } },
  ]) {
    const mode = await resolveBackupMode({ ...options, sleep: noSleep });
    assert.deepEqual(mode, { noR2: true, notice: null });
  }
});

test('require-r2 stops when the check fails', async () => {
  await assert.rejects(
    () => resolveBackupMode({ ...probeResult({ ok: false, output: 'R2 is not enabled' }), requireR2: true }),
    /R2 is required but not available/,
  );
});

test('require-r2 and no-r2 together are rejected', async () => {
  await assert.rejects(
    () => resolveBackupMode({ requested: true, noR2: true, requireR2: true, probeR2: async () => ({ ok: true, output: '' }) }),
    /not both/,
  );
});

const deploySpy = (onConfig) => (execPath, args) => {
  const configPath = args[args.indexOf('--config') + 1];
  if (configPath.endsWith('.jsonc') && configPath.includes('.wrangler-deploy-')) onConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  return { status: 0 };
};

const temporaryConfigs = () =>
  readdirSync(new URL('..', import.meta.url)).filter((name) => name.startsWith('.wrangler-deploy-'));

test('deployStorage deploys the reduced config when R2 is unavailable', async () => {
  const seen = [];
  let probes = 0;
  const code = await deployStorage(['wrangler.jsonc', ''], {
    probeR2: async () => {
      probes++;
      return { ok: false, output: 'R2 is not enabled for this account' };
    },
    spawn: deploySpy((config) => seen.push(config)),
    sleep: async () => {},
  });
  assert.equal(code, 0);
  assert.equal(probes, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].vars.BACKUP_ENABLED, 'false');
  assert.equal((seen[0].r2_buckets ?? []).some((bucket) => bucket.binding === 'BACKUP_BUCKET'), false);
  assert.deepEqual(temporaryConfigs(), []);
});

test('deployStorage deploys the untouched config when R2 is available', async () => {
  const seen = [];
  let probes = 0;
  const code = await deployStorage(['wrangler.jsonc', ''], {
    probeR2: async () => {
      probes++;
      return { ok: true, output: '' };
    },
    spawn: deploySpy((config) => seen.push(config)),
    sleep: async () => {},
  });
  assert.equal(code, 0);
  assert.equal(probes, 1);
  assert.deepEqual(seen, [], 'an enabled config needs no temporary file');
  assert.deepEqual(temporaryConfigs(), []);
});

test('deployStorage does not check R2 or require a value with --no-r2', async () => {
  const source = structuredClone(template);
  delete source.vars.BACKUP_ENABLED;
  const path = `${new URL('..', import.meta.url).pathname}.wrangler-test-invalid.jsonc`;
  writeFileSync(path, JSON.stringify(source), { mode: 0o600 });
  try {
    const seen = [];
    const code = await deployStorage([path, '', '--no-r2'], {
      probeR2: async () => { throw new Error('must not run'); },
      spawn: deploySpy((config) => seen.push(config)),
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(seen[0].vars.BACKUP_ENABLED, 'false');
  } finally {
    rmSync(path, { force: true });
  }
});

test('deployStorage stops before deploying when --require-r2 finds no R2', async () => {
  let spawned = 0;
  await assert.rejects(
    () =>
      deployStorage(['wrangler.jsonc', '', '--require-r2'], {
        probeR2: async () => ({ ok: false, output: 'R2 is not enabled' }),
        spawn: () => { spawned++; return { status: 0 }; },
        sleep: async () => {},
      }),
    /R2 is required but not available/,
  );
  assert.equal(spawned, 0);
  assert.deepEqual(temporaryConfigs(), []);
});

test('deployStorage propagates a deploy failure and removes the temporary file', async () => {
  const code = await deployStorage(['wrangler.jsonc', ''], {
    probeR2: async () => ({ ok: false, output: 'R2 is not enabled' }),
    spawn: () => ({ status: 7 }),
    sleep: async () => {},
  });
  assert.equal(code, 7);
  assert.deepEqual(temporaryConfigs(), []);
});
