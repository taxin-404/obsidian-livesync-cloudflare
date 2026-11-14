import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { backupsRequested, deployArgs, deploymentConfig } from '../scripts/deploy-storage.mjs';

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

test('parses --no-r2 out of the Wrangler arguments', () => {
  assert.deepEqual(deployArgs(['wrangler.jsonc', '', '--no-r2', '--dry-run']), {
    configPath: 'wrangler.jsonc',
    environment: '',
    noR2: true,
    wranglerArgs: ['--dry-run'],
  });
  assert.deepEqual(deployArgs(['wrangler.jsonc', 'dev']), {
    configPath: 'wrangler.jsonc',
    environment: 'dev',
    noR2: false,
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
