# Automatic R2 detection design

## Intent

A first-time user should not have to know whether their Cloudflare account can
use R2. The deploy checks, then deploys with backups when R2 is available and
without backups when it is not. No dashboard choice, no second command.

Why: R2 requires a billing profile with an accepted card, which some users
cannot provide. Sync itself needs only Workers and Durable Objects.

## Goals

- The normal deploy command detects R2 and does the right thing.
- An account with R2 deployed today behaves exactly as before.
- A user can still force either outcome.
- Existing buckets and their objects are never touched.
- Clear one-line output saying what was detected and what was deployed.

## Non-goals

- Replacing R2 with another backup store.
- Detecting R2 at runtime inside the Worker.
- Changing the MCP Worker.
- Making backups opt-in for users who already have them.

## Anti-goals

- A transient check failure silently removing backups with no explanation.
- A permission or account error being mistaken for "no R2" and hiding a real
  misconfiguration.
- Any change to a live deployment's data.

## Constraints

- Cloudflare free plan; no new dependencies.
- The Workers Builds token already has R2 permission, so the check can run
  there. Locally, `wrangler login` has it too.
- Keep `wrangler.jsonc` as the source of truth.
- No secret is printed.

## Approaches considered

1. **Check first, then deploy (chosen).** The deploy asks Cloudflare whether R2
   is available, then deploys with backups or without. One extra API call.
2. **Try with backups, fall back on deploy failure.** No extra check, but a
   deploy only fails after uploading and mixes "no R2" with unrelated errors.
   Rejected: it cannot separate causes cleanly.
3. **A one-time manual choice.** Predictable but not automatic. Rejected: the
   user asked for automatic.

## Design

### Modes

| Flag | Behaviour |
| --- | --- |
| none | **auto** — check R2, then deploy accordingly |
| `--no-r2` | force backups off; no check |
| `--require-r2` | require backups; if the check fails, stop without deploying |

`--no-r2` and `--require-r2` together are an error. The existing
`npm run deploy:no-r2` keeps working and maps to `--no-r2`.

### Decision

`backupsRequested(text, environment)` reads `BACKUP_ENABLED` for the selected
environment and returns `true`/`false`, or throws the current validation error.
Auto only checks when the answer is `true`; when it is `false` the deploy
reduces the config as it does today and no check runs.

`resolveBackupMode({ requested, noR2, requireR2, probeR2 })` returns
`{ noR2, notice }`. It owns the small decision table above and is unit-tested
directly.

### The check

Run the already-installed Wrangler:

```sh
node <wrangler>/bin/wrangler.js r2 bucket list
```

- Success (exit 0) means R2 is available.
- Failure is retried once.
- A failure that names an account-selection, authentication, or network problem
  (`multiple accounts`, `account_id`, `not authenticated`, `Authentication`,
  `fetch failed`, `ENOTFOUND`, `ECONN`) **stops the deploy** and shows the
  Wrangler message. These mean the deploy itself cannot succeed, so guessing
  would hide the cause.
- Any other failure means R2 is unavailable: deploy without backups and print
  one line with the first line of the error and the reminder that bucket data
  is untouched.
- `--require-r2` turns that last case into a stop with the same message.

### Wiring

`deployStorage(argv, { probeR2, spawn })` takes injectable collaborators so the
whole path is testable without network access:

- `probeR2()` returns `{ ok, output }`.
- `spawn` is the existing `spawnSync` call, injectable so a test can inspect the
  temporary config file the deploy would use.

`deployStorage` becomes async (the retry pause), and the CLI entry awaits it.
The temporary config lifecycle, the missing-file message, and the `finally`
cleanup stay unchanged.

### Output

```
R2 is available — deploying with backups.
```

or

```
R2 is not available on this account (<first line of error>).
Deploying without backups. The bucket and its data are untouched; the next
deploy restores backups once R2 is enabled.
```

## Tests

Unit, in `test/deploy-storage.test.mjs`:

- `backupsRequested`: `true`, `false`, missing/boolean/invalid, `env.dev`,
  missing environment.
- `resolveBackupMode`: auto with check ok; auto with check failed; auto with
  `BACKUP_ENABLED="false"` (no check); `--no-r2` (no check, probe not called);
  `--require-r2` with failure (throws); retry once on failure and not on
  success; abort patterns for account/auth/network; conflict of both flags.
- `deployArgs`: parses `--require-r2`, never forwards it, rejects the pair.
- Full `deployStorage` path with a fake probe and fake spawn: reads the written
  temporary config, asserts `BACKUP_ENABLED="false"` and no `BACKUP_BUCKET`
  when R2 is missing, and that the file is removed afterwards; and asserts the
  untouched config when R2 is present.
- No secret (password, URI, bucket credential) appears in output.

Real commands on this R2-enabled account:

- `npm run deploy -- --dry-run` — check succeeds, deploy proceeds, temp file
  removed.
- `npm run deploy -- --require-r2 --dry-run` — same.
- `npm run deploy:no-r2 -- --dry-run` — no check, reduced config (existing).

The no-R2 account case cannot be run here (both available accounts have R2), so
it is covered by the injected-probe tests above; the reduced config itself is
already exercised against a real dry run.

## Documentation

- README top box and Option A/B: auto is the default; scripts recommend
  `npm run deploy`; mention `--require-r2`.
- `docs/backup-recovery.md#deploy-without-r2`: auto first, manual flags second.
- `docs/auto-deploy.md`: deploy command options.
- `DEPLOY.md`: command table.

## What is left to the builder

- Exact flag parsing style, following `deployArgs`.
- Retry pause length (a short, fixed wait; no dependency).
- Prose for the two notices.

## Cost if wrong

- Probe failure on an R2 account disables backups for one deploy; bucket and
  data are untouched and the next deploy restores them. The notice states this.
- `--require-r2` is the escape hatch for users who never want that.
