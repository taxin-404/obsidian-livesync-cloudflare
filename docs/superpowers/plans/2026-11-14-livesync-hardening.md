# LiveSync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an upstream-PouchDB compatibility workflow and a `vault:doctor` guard that flags local Obsidian vaults sharing one sync target.

**Architecture:** Two independent, read-only additions. A new scheduled GitHub workflow runs the existing `test/current-pouchdb.test.ts` against a real `pouchdb/pouchdb` checkout. A new `scripts/vault-doctor.mjs` reads each vault's `data.json`, decrypts every remote it can, and reports targets used by more than one vault. Neither touches the storage Worker, the Durable Object, backups, or deployment.

**Tech Stack:** Node.js (`^22.18.0 || >=24.11.0`), `node:test`, `node:fs/promises`, `yaml` 2.9.1 (already a dependency), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-14-livesync-hardening-design.md`

## Global Constraints

- Cloudflare free tier; deploys run through Workers Builds.
- Node.js `^22.18.0 || >=24.11.0`; CI uses Node 24.
- Never print a secret: server password, E2EE passphrase, ID derivation key, or setup URI.
- Match repo conventions: ES-module scripts in `scripts/*.mjs`, tests in `test/*.test.mjs`, commands wired into `package.json`.
- Stay compatible with Obsidian LiveSync 1.0.49 with E2EE enabled.
- No production/protocol change; no new binding, cron, queue, or paid feature.

## Review Focus

- A vault whose `activeConfigurationId` is empty still syncs (the `dsfsdaw` bug) — the guard must still count it. (Task 1)
- A vault with no readable remote entries but a matching legacy `encryptedCouchDBConnection` — must still register its target. (Task 1)
- A remote entry stored in plaintext (`isEncrypted: false`, no `%$` prefix) — must not throw. (Task 1)
- A missing or malformed Obsidian registry file — must not throw, just yield no vaults from it. (Task 1)
- Any secret (password, passphrase, key, `%$` blob) appearing in the report or CLI output — must never happen. (Task 1)
- The workflow checks out PouchDB anywhere other than a sibling of the Worker checkout — the suite's `../../pouchdb` import would not resolve. (Task 2)

---

### Task 1: `vault:doctor` script, tests, wiring and docs

**Files:**
- Create: `scripts/vault-doctor.mjs`
- Create: `test/vault-doctor.test.mjs`
- Modify: `package.json` (`scripts`)
- Modify: `docs/credentials.md` (next to the `check:secrets` section)

**Interfaces:**
- Consumes: `dataFilePath`, `configPassphrase`, `decryptValue`, `isEncryptedBlob`, `parseRemote` from `scripts/livesync-config.mjs`; `flagValue` from `scripts/livesync-cli.mjs`.
- Produces (used by the test and by later docs):
  - `doctorVaults(vaultDirs: string[]) -> Promise<Report>`
  - `discoverVaults({ vaults?: string[], roots?: string[], registryPath?: string }) -> Promise<string[]>`
  - `parseArgs(argv: string[]) -> { vaults: string[], roots: string[], json: boolean }`
  - `Report = { ok: boolean, exitCode: 0 | 1, vaults: VaultReport[], collisions: Collision[] }`
  - `VaultReport = { name: string, dir: string, liveSync: boolean, activeConfigurationId: string, targets: string[], error?: string }`
  - `Collision = { target: string, vaults: string[] }`

- [ ] **Step 1: Write the failing test**

Create `test/vault-doctor.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { discoverVaults, doctorVaults, parseArgs } from '../scripts/vault-doctor.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

test('reports a collision when two vaults share a remote', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
  assert.equal(report.collisions[0].vaults.length, 2);
});

test('reports no collision when vaults use different remotes', async () => {
  const a = await makeVault();
  const b = await makeVault({ remoteProduct: 'sls+https://admin:pw@other.test/?db=vault' });
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.collisions, []);
});

test('counts a vault that has no active remote configuration', async () => {
  const a = await makeVault();
  const b = await makeVault({ activeConfigurationId: '' });
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
});

test('detects a collision through the legacy connection only', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const raw = JSON.parse(await readFile(b.dataPath, 'utf8'));
  delete raw.remoteConfigurations;
  await writeFile(b.dataPath, `${JSON.stringify(raw, null, 2)}\n`);
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
});

test('reads a plaintext remote entry', async () => {
  const a = await makeVault();
  const b = await makeVault({ storedRemoteUri: 'sls+https://admin:pw@host.test/?db=vault' });
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.collisions.map((c) => c.target), ['host.test/vault']);
});

test('returns no vaults when the registry is missing', async () => {
  const dirs = await discoverVaults({ registryPath: '/definitely/not/here.json' });
  assert.deepEqual(dirs, []);
});

test('never prints a secret', async () => {
  const a = await makeVault();
  const b = await makeVault();
  const report = await doctorVaults([a.vaultDir, b.vaultDir]);
  const text = JSON.stringify(report);
  assert.equal(text.includes(a.password), false);
  assert.equal(text.includes(a.e2eePassphrase), false);
  assert.equal(text.includes(a.idDerivationKey), false);
  assert.equal(text.includes('%$'), false);
});

test('parses the doctor arguments', () => {
  assert.deepEqual(parseArgs(['--vault', '/a', '--root', '/b', '--json']), {
    vaults: ['/a'],
    roots: ['/b'],
    json: true,
  });
  assert.deepEqual(parseArgs([]), { vaults: [], roots: [], json: false });
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
  assert.throws(() => parseArgs(['--vault']), /--vault needs a value/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/vault-doctor.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/vault-doctor.mjs'`.

- [ ] **Step 3: Implement `scripts/vault-doctor.mjs`**

Exports exactly the signatures in **Interfaces**. Key decisions:

- `targetOf(remote)`: database is `new URLSearchParams(remote.search).get('db')`, else the trimmed `pathname`, else `''`; target is `` `${remote.host}/${db}` ``.
- Per remote entry: use the URI as-is when `!isEncryptedBlob(rc.uri)`, otherwise `await decryptValue(rc.uri, passphrase)`; wrap each in `try/catch` and skip unreadable ones. Collect into a `Set`.
- Legacy: `JSON.parse(await decryptValue(data.encryptedCouchDBConnection, passphrase))`, then add `` `${new URL(legacy.couchDB_URI).host}/${legacy.couchDB_DBNAME ?? ''}` `` inside `try/catch`.
- `inspectVault` reads `dataFilePath(vaultDir)` directly (never `readVault`, which rejects a vault with no active remote).
- `doctorVaults` records an unreadable vault as `{ ..., targets: [], error }` instead of throwing; groups targets into `Map<target, string[]>`; `collisions` are entries with more than one vault name; `ok`/`exitCode` follow from `collisions.length`.
- `discoverVaults` unions `vaults`, one-level `readdir` of each `roots` entry, and `Object.values(registry.vaults).map((v) => v.path)`; verify each with `access(dataFilePath(dir))`; return resolved, de-duplicated paths; swallow all discovery errors.
- CLI `main` prints one line per vault (`name`, `sync on/off`, targets or `(no remote)`), then one block per collision naming the vaults and advising to keep one and turn LiveSync off in the others; `--json` prints the report. `process.exitCode = report.exitCode`. Guard the entry point with the same `import.meta.url === pathToFileURL(process.argv[1]).href` pattern used by `check-secrets.mjs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/vault-doctor.test.mjs`
Expected: PASS — 8 tests, 0 failures.

- [ ] **Step 5: Wire the command and document it**

- `package.json`: add `"vault:doctor": "node scripts/vault-doctor.mjs"`, and append `test/vault-doctor.test.mjs` to the `test:secrets` list so it runs in CI (`test:secrets` is invoked by `npm test`).
- `docs/credentials.md`: near the `check:secrets` section, add a short `npm run vault:doctor` note: it scans local vaults, prints each one's sync target and `sync on/off`, exits non-zero when two vaults share a target, and changes nothing.

- [ ] **Step 6: Commit**

```bash
git add scripts/vault-doctor.mjs test/vault-doctor.test.mjs package.json docs/credentials.md
git commit -m "Add vault:doctor to flag vaults sharing a sync target"
```

---

### Task 2: Upstream PouchDB compatibility workflow

**Files:**
- Create: `.github/workflows/upstream-pouchdb.yml`
- Create: `test/upstream-pouchdb-workflow.test.mjs`
- Modify: `package.json` (`test:upstream` script)

**Interfaces:**
- Consumes: the existing `npm run test:upstream-pouchdb` (→ `test/current-pouchdb.test.ts`) and the sibling `../pouchdb` checkout layout that test already assumes.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing test**

Create `test/upstream-pouchdb-workflow.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/upstream-pouchdb-workflow.test.mjs`
Expected: FAIL — `ENOENT` for `.github/workflows/upstream-pouchdb.yml`.

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/upstream-pouchdb.yml` with exactly:

```yaml
name: Upstream PouchDB compatibility

on:
  workflow_dispatch:
  schedule:
    - cron: "23 4 * * *"
  push:
    paths:
      - package.json
      - package-lock.json
      - .github/workflows/upstream-pouchdb.yml
      - test/current-pouchdb.test.ts
  pull_request:
    paths:
      - package.json
      - package-lock.json
      - .github/workflows/upstream-pouchdb.yml
      - test/current-pouchdb.test.ts

permissions:
  contents: read

jobs:
  compatibility:
    runs-on: ubuntu-latest
    steps:
      - name: Check out this Worker
        uses: actions/checkout@v4
        with:
          path: cloudflare-obsidian-livesync
          persist-credentials: false

      - name: Check out upstream PouchDB
        uses: actions/checkout@v4
        with:
          repository: pouchdb/pouchdb
          path: pouchdb
          persist-credentials: false

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: cloudflare-obsidian-livesync/package-lock.json

      - name: Build upstream PouchDB modules
        working-directory: pouchdb
        run: |
          npm install
          npm run build-modules

      - name: Install Worker dependencies
        working-directory: cloudflare-obsidian-livesync
        run: npm ci

      - name: Run upstream compatibility suite
        working-directory: cloudflare-obsidian-livesync
        run: npm run test:upstream-pouchdb
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/upstream-pouchdb-workflow.test.mjs`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 5: Run it in CI**

- `package.json`: change `test:upstream` to
  `node --test test/upstream-sync.test.mjs test/upstream-pouchdb-workflow.test.mjs`
  (`test:upstream` is run by our `.github/workflows/ci.yml`).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/upstream-pouchdb.yml test/upstream-pouchdb-workflow.test.mjs package.json
git commit -m "Add upstream PouchDB compatibility workflow"
```

---

### Task 3: Whole-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the repo's CI commands**

Run: `npm run check:storage && npm run test:upstream && npm test && npm run dry-run`
Expected: `tsc` clean; both node test files pass; the full Vitest suite passes (including `test:secrets` with the new file); both Workers bundle with no error.

- [ ] **Step 2: Confirm the guard against the real vaults**

Run: `npm run vault:doctor -- --json`
Expected: JSON with one entry per discovered vault; `collisions` listing `live.obsidian-sync.workers.dev/vault` while any throwaway vault still points there; no secret anywhere in the output.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "Verify LiveSync hardening checks"
```
