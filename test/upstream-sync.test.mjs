import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNameStatus, portPlan, readUpstreamConfig } from '../scripts/upstream-sync.mjs';

test('upstream config requires a repository, branch and commit pin', () => {
  const valid = '{"repository":"https://example.test/repo.git","branch":"main","baseCommit":"a14fc4b"}';
  assert.deepEqual(readUpstreamConfig(valid), {
    repository: 'https://example.test/repo.git',
    branch: 'main',
    baseCommit: 'a14fc4b',
  });
  assert.throws(() => readUpstreamConfig('not json'), /not valid JSON/);
  for (const key of ['repository', 'branch', 'baseCommit']) {
    const config = JSON.parse(valid);
    delete config[key];
    assert.throws(() => readUpstreamConfig(JSON.stringify(config)), new RegExp(`missing "${key}"`));
  }
  assert.throws(
    () => readUpstreamConfig(JSON.stringify({ ...JSON.parse(valid), baseCommit: 'not a hash' })),
    /must be a git commit hash/,
  );
});

test('name-status output keeps renames addressable by both paths', () => {
  const parsed = parseNameStatus('M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR100\tsrc/old.ts\tsrc/new.ts\n');
  assert.deepEqual(parsed, [
    { status: 'M', path: 'src/a.ts', previousPath: undefined },
    { status: 'A', path: 'src/b.ts', previousPath: undefined },
    { status: 'D', path: 'src/c.ts', previousPath: undefined },
    { status: 'R', path: 'src/new.ts', previousPath: 'src/old.ts' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

test('port plan separates clean applies from files that need judgement', () => {
  const upstream = [
    { status: 'M', path: 'src/index.ts' },
    { status: 'M', path: 'src/pouch-database.ts' },
    { status: 'A', path: 'src/feature.ts' },
    { status: 'A', path: '.github/workflows/new.yml' },
    { status: 'M', path: 'docs/readme.md' },
  ];
  const local = [
    { status: 'M', path: 'src/pouch-database.ts' },
    { status: 'D', path: '.github/workflows/new.yml' },
  ];
  const plan = portPlan(upstream, local);
  assert.equal(plan[0].note, '');
  assert.match(plan[1].note, /changed here too/);
  assert.equal(plan[2].note, '');
  assert.match(plan[3].note, /deleted here/);
  assert.equal(plan[4].note, '');
  assert.equal(portPlan([], local).length, 0);
});
