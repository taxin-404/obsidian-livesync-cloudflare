# No-R2 deployment design

## Intent

A first deployment must be possible on a Cloudflare account that cannot enable
R2 — because a card or billing profile is required and is unavailable in the
user's country. Sync only needs Workers and Durable Objects; backups are the
only R2-dependent feature.

## Goals

- One command deploys the storage Worker with no R2 binding and backups off.
- The same mode works from Workers Builds, without a terminal or API token.
- Accounts that already use R2 backups are unaffected.
- Enabling R2 later is a config change, not a migration.

## Non-goals

- Replacing R2 with another backup store.
- Making no-R2 the default.
- Deleting existing buckets or their contents.

## Constraints

- Cloudflare free plan; no new dependencies.
- Deploy must not touch Worker secrets or Durable Object data.
- `wrangler.jsonc` stays the source of truth for the normal, backup-enabled
  deployment.

## Approaches

1. **Docs only.** Point at the existing `BACKUP_ENABLED=false` +
   `npm run deploy:storage` route. No code risk, but it needs a local checkout
   and an ignored config file, so Workers Builds users are still blocked.
2. **Deploy-script flag (chosen).** Add `--no-r2` to the existing deployment
   script, which already builds a temporary config when backups are disabled.
   One command locally, and the same command can be the Workers Builds deploy
   step.
3. **No-R2 default.** Easiest for new users, but a deploy would remove backups
   from existing deployments. Rejected.

## Design

- `deploymentConfig(text, environment, { noR2 })`:
  - `noR2` forces `vars.BACKUP_ENABLED = "false"` for the selected environment;
  - removes the `BACKUP_BUCKET` entry from `r2_buckets`, keeping any other
    bucket bindings;
  - sets `triggers.crons` to `[]`;
  - returns the modified config instead of `null`.
- `deployStorage` accepts `--no-r2`, strips it from the arguments passed to
  Wrangler, and asks `deploymentConfig` for the reduced config. The temporary
  config keeps the existing `--config`/`--env` handling.
- New script: `npm run deploy:no-r2`.
- Workers Builds deploy command:
  `node scripts/deploy-storage.mjs wrangler.jsonc "" --no-r2`.
- Docs: a "No card / no R2" section in `docs/backup-recovery.md`, linked from
  `README.md`, stating that sync works, backup and restore endpoints return
  `503`, and users must keep their own exports.
- Turning backups back on is the existing path: set `BACKUP_ENABLED` back to
  `"true"` and redeploy with `npm run deploy`; existing bucket contents remain.

## Failure behaviour

- A no-R2 deploy over an R2-enabled Worker removes the binding and schedule but
  leaves the bucket and its objects untouched.
- Manual `POST /_backup` and restore return `503`; `/health` omits backup age.
- No other route or sync behaviour changes.
