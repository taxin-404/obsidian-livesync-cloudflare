import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deploymentConfig } from '../scripts/deploy-storage.mjs';

const template = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('backup deployment flag preserves enabled configs and strips resources only in the selected environment', () => {
  for (const environment of ['', 'dev']) {
    const source = structuredClone(template);
    const selected = environment ? source.env[environment] : source;
    assert.equal(deploymentConfig(JSON.stringify(source), environment), null);
    selected.vars.BACKUP_ENABLED = 'false';
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
    const result = deploymentConfig(JSON.stringify(source), environment, { noR2: true });
    const expected = structuredClone(source);
    const target = environment ? expected.env[environment] : expected;
    target.vars.BACKUP_ENABLED = 'false';
    target.r2_buckets = target.r2_buckets.filter((bucket) => bucket.binding !== 'BACKUP_BUCKET');
    target.triggers = { ...target.triggers, crons: [] };
    assert.deepEqual(result, expected);
    assert.equal(selected.vars.BACKUP_ENABLED, 'true', 'the parsed source is not mutated');
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
