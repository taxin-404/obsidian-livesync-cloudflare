# Automatic R2 Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deploy detect whether the account can use R2, then deploy with backups when it can and without backups when it cannot.

**Architecture:** Parse the selected config's `BACKUP_ENABLED`, run `wrangler r2 bucket list` once (retried once) when backups are wanted, and pass the result into the existing reduced-config transform. Everything network- or process-related is injectable so the full path is unit-tested, and `--no-r2` / `--require-r2` override the decision.

**Tech Stack:** Node.js 22.18+/24.11+, Wrangler 4.45+, `node:test`, `spawnSync`.

**Spec:** `docs/superpowers/specs/2026-11-14-auto-r2-detection-design.md`

## Global Constraints

- Cloudflare free plan; no new dependencies.
- Default deploy behaviour: auto. Existing R2 deployments must be unchanged.
- Never touch bucket objects; never print a secret.
- `wrangler.jsonc` stays the source of truth.
- Keep the temporary-config lifecycle, mode `600`, `wx`, and `finally` cleanup.
- The Workers Builds token already has R2 permission; the check uses the same Wrangler install as the deploy.

## File Structure

- `scripts/deploy-storage.mjs` — decision helpers (`backupsRequested`, `resolveBackupMode`), flag parsing, async `deployStorage`.
- `test/deploy-storage.test.mjs` — all unit tests, including the full path with fake probe and fake spawn.
- `README.md`, `docs/backup-recovery.md`, `docs/auto-deploy.md`, `DEPLOY.md` — auto behaviour and flags.

## Review Focus

- **`--no-r2` with a missing or invalid `BACKUP_ENABLED`:** must still deploy the reduced config; the new validation must not run in this mode.
- **`--require-r2` with R2 available:** must deploy the untouched `wrangler.jsonc` and create no temporary file.
- **`--no-r2 --require-r2` together:** must stop before any probe, temp file, or deploy.
- **Probe output naming an account/auth/network problem:** must stop the deploy with that message, not deploy without backups.
- **Injected deploy failure:** the exit status must propagate and the temporary config must still be removed.

---

### Task 1: Read whether backups are requested

**Files:**
- Modify: `scripts/deploy-storage.mjs:9-24`
- Test: `test/deploy-storage.test.mjs`

**Interfaces:**
- Consumes: `ts.parseConfigFileTextToJson`.
- Produces: `backupsRequested(text: string, environment = ''): boolean` — `true` for `"true"`, `false` for `"false"`, otherwise throws the same messages as `deploymentConfig`.

- [ ] **Step 1: Write the failing tests**

Add `backupsRequested` to the import, then append:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:deploy`
Expected: FAIL because `backupsRequested` is not exported.

- [ ] **Step 3: Implement `backupsRequested`**

Add it beside `deploymentConfig`, sharing the same parse and validation wording:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:deploy`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-storage.mjs test/deploy-storage.test.mjs
git commit -m "Read whether the deployment config asks for backups"
```

---

### Task 2: Decide the backup mode from the R2 check

**Files:**
- Modify: `scripts/deploy-storage.mjs`
- Test: `test/deploy-storage.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 directly; the caller passes `requested`.
- Produces: `resolveBackupMode({ requested, noR2 = false, requireR2 = false, probeR2, retryDelayMs = 1500, sleep = defaultSleep })` → `Promise<{ noR2: boolean, notice: string | null }>`. `probeR2: () => Promise<{ ok: boolean, output: string }>`.

- [ ] **Step 1: Write the failing tests**

Import `resolveBackupMode`, then append (use a no-op `sleep`):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:deploy`
Expected: FAIL because `resolveBackupMode` is not exported.

- [ ] **Step 3: Implement `resolveBackupMode` in `scripts/deploy-storage.mjs`**

Add a module-level `summarize(output)` that strips ANSI escapes, drops Wrangler's banner and blank/rule lines (`/wrangler \d/`, `/update available/i`, `/^[─\s]+$/`), and returns the first remaining trimmed line, or `'unknown error'`. Then:

```js
const R2_ABORT_PATTERN =
  /multiple accounts|account_id|not authenticated|authentication|fetch failed|ENOTFOUND|ECONN/i;

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:deploy`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-storage.mjs test/deploy-storage.test.mjs
git commit -m "Decide the backup mode from an R2 availability check"
```

---

### Task 3: Add the `--require-r2` flag

**Files:**
- Modify: `scripts/deploy-storage.mjs:26-40`
- Test: `test/deploy-storage.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `deployArgs(argv)` additionally returns `requireR2: boolean` and excludes `--require-r2` from `wranglerArgs`.

- [ ] **Step 1: Write the failing test**

Replace the existing `parses --no-r2 out of the Wrangler arguments` test body with:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:deploy`
Expected: FAIL because `requireR2` is missing from the result.

- [ ] **Step 3: Implement the flag in `deployArgs`**

Update the usage text to `CONFIG ENV [--no-r2 | --require-r2] [Wrangler deploy options]`, add `requireR2: args.includes('--require-r2')`, and filter both flags:

```js
wranglerArgs: args.filter(arg => arg !== '--no-r2' && arg !== '--require-r2'),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:deploy`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-storage.mjs test/deploy-storage.test.mjs
git commit -m "Accept a --require-r2 deployment flag"
```

---

### Task 4: Wire the check into the deploy

**Files:**
- Modify: `scripts/deploy-storage.mjs:42-74`
- Test: `test/deploy-storage.test.mjs`

**Interfaces:**
- Consumes: `backupsRequested` (Task 1), `resolveBackupMode` (Task 2), `deployArgs.requireR2` (Task 3), `deploymentConfig`.
- Produces: `deployStorage(argv, { probeR2 = createR2Probe(), spawn = spawnSync, sleep } = {})` → `Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Add `readdirSync`, `writeFileSync` and `rmSync` to the `node:fs` import. Append:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:deploy`
Expected: FAIL because `deployStorage` ignores the injected options and still deploys with backups.

- [ ] **Step 3: Implement the async `deployStorage`**

Keep the missing-file message and `finally` cleanup. Add a factory beside the function:

```js
function createR2Probe() {
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  return () => {
    const result = spawnSync(process.execPath, [wrangler, 'r2', 'bucket', 'list'], { encoding: 'utf8' });
    return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
}
```

Then:

```js
export async function deployStorage(argv, { probeR2 = createR2Probe(), spawn = spawnSync, sleep } = {}) {
  const { configPath, environment, noR2, requireR2, wranglerArgs } = deployArgs(argv);
  // ...existing readFileSync block...
  const requested = noR2 ? false : backupsRequested(text, environment);
  const mode = await resolveBackupMode({ requested, noR2, requireR2, probeR2, sleep });
  if (mode.notice) console.log(mode.notice);
  const config = deploymentConfig(text, environment, { noR2: mode.noR2 });
  // ...existing temporary-file setup...
  const result = spawn(process.execPath, [wrangler, 'deploy', '--config', temporary ?? source, '--env', environment, ...wranglerArgs], { stdio: 'inherit' });
  // ...existing result handling and finally cleanup...
}
```

Passing `sleep: undefined` through uses `resolveBackupMode`'s own default, so no special handling is needed. Await `deployStorage` in the CLI entry:

```js
try { process.exitCode = await deployStorage(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:deploy`
Expected: all tests pass and no `.wrangler-deploy-*.jsonc` remains.

- [ ] **Step 5: Real dry runs**

First, with the account **not** selected (unset `CLOUDFLARE_ACCOUNT_ID` and no default), confirm the abort path is real:

```sh
env -u CLOUDFLARE_ACCOUNT_ID npm run deploy -- --dry-run
```

Expected: exit `1`, `Cannot check R2: ...`, and no temporary config — the probe refused to guess when it could not select an account.

Then export `CLOUDFLARE_ACCOUNT_ID` for an account that has R2 (the operator's own value, never committed) and run:

```sh
npm run deploy -- --dry-run
npm run deploy -- --require-r2 --dry-run
npm run deploy:no-r2 -- --dry-run
ls .wrangler-deploy-*.jsonc 2>/dev/null || echo "no temporary config left"
```

Expected: exit `0`; the first two say `R2 is available` and print the normal binding list with R2; the third prints no R2 binding and runs no check; no leftover temporary config. This account has R2, so the "not available" branch is covered only by the injected tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-storage.mjs test/deploy-storage.test.mjs
git commit -m "Detect R2 before deploying and fall back without backups"
```

---

### Task 5: Document the automatic behaviour

**Files:**
- Modify: `README.md`, `docs/backup-recovery.md`, `docs/auto-deploy.md`, `DEPLOY.md`

**Interfaces:**
- Consumes: `npm run deploy` (auto), `--no-r2`, `--require-r2` from Task 4.
- Produces: no code.

- [ ] **Step 1: Update the README**

- Top box: replace the manual `npm run deploy:no-r2` instruction with the automatic behaviour: `npm run deploy` checks R2 and needs no choice; `--no-r2` and `--require-r2` force an outcome.
- Option A: make `npm run deploy` the recommended deploy command so Workers Builds gets the check; keep `npx wrangler deploy` as the no-check alternative and say what it does when R2 is absent (it fails, so use the script).
- Option B: `npm run deploy` now checks R2; keep `deploy:no-r2` as the forced variant.
- Operations paragraph: name both flags.

- [ ] **Step 2: Update `docs/backup-recovery.md`**

In `#deploy-without-r2`: lead with automatic detection, then the forced commands. State the notice text, the retry, the stop cases (account/auth/network), `--require-r2` as the strict option, and that bucket data is untouched. Keep the custom-config route.

- [ ] **Step 3: Update `docs/auto-deploy.md` and `DEPLOY.md`**

Point the deploy command at `npm run deploy` for auto, note `--require-r2`, and link `backup-recovery.md#deploy-without-r2`.

- [ ] **Step 4: Run the checks**

Run: `npm run check && npm run test:deploy`
Expected: both exit `0`.

- [ ] **Step 5: Verify the documentation links and commands**

```sh
node -e "const s=require('./package.json').scripts; if (!s['deploy'] || !s['deploy:no-r2']) process.exit(1); console.log('scripts ok')"
npm run deploy:no-r2 -- --dry-run
```

Expected: `scripts ok`, then a dry run with `BACKUP_ENABLED` `"false"` and no R2 binding.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/backup-recovery.md docs/auto-deploy.md DEPLOY.md
git commit -m "Document automatic R2 detection"
```

---

## Verification

After all tasks:

```sh
npm run test:deploy
npm run test:backup
npm test
npm run check
git status --short
```

Expected: all exit `0` and the worktree is clean. Do not deploy against the live Worker as part of this work; the live deployment keeps R2 enabled and its deploy command can adopt `npm run deploy` separately.
