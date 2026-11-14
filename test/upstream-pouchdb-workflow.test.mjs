import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

const WORKFLOW = '.github/workflows/upstream-pouchdb.yml';

test('runs the upstream PouchDB compatibility suite on a schedule', async () => {
  const doc = parse(await readFile(WORKFLOW, 'utf8'));
  assert.ok(Array.isArray(doc.on.schedule) && doc.on.schedule.length > 0, 'has a schedule');
  assert.ok('workflow_dispatch' in doc.on, 'can be run on demand');
  assert.equal(doc.permissions.contents, 'read');

  const steps = doc.jobs.compatibility.steps;
  assert.ok(
    steps.some((s) => s.uses?.startsWith('actions/checkout') && s.with?.path === 'cloudflare-obsidian-livesync'),
    'checks out this Worker',
  );
  assert.ok(
    steps.some(
      (s) =>
        s.uses?.startsWith('actions/checkout') &&
        s.with?.repository === 'pouchdb/pouchdb' &&
        s.with?.path === 'pouchdb',
    ),
    'checks out upstream PouchDB as a sibling of the Worker',
  );
  assert.ok(steps.some((s) => s.with?.['node-version'] === 24), 'uses Node 24');
  assert.ok(
    steps.some((s) => typeof s.run === 'string' && s.run.includes('npm run build-modules')),
    'builds the PouchDB modules',
  );
  assert.ok(
    steps.some((s) => s.run === 'npm run test:upstream-pouchdb'),
    'runs the compatibility suite',
  );
});

test('the compatibility suite the workflow runs exists', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(pkg.scripts['test:upstream-pouchdb'], 'npm run test:upstream-pouchdb is defined');
  await readFile('test/current-pouchdb.test.ts', 'utf8');
});
