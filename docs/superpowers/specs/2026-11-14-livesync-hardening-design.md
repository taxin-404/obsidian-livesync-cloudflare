# LiveSync hardening: PouchDB compatibility check and multi-vault guard

Status: approved design, 14 November 2026. Source: an audit of the upstream
snapshot (`robince/cloudflare-obsidian-livesync-mcp` at `a14fc4b`) that found no
new upstream work to port, plus the multi-vault incident that jammed the `notes`
vault. No production or protocol change is involved.

## Intent

Keep this deployment the best, fastest, free LiveSync it can be. MCP is out of
scope: it only exposes the vault to AI tools and has nothing to do with syncing.
Two concrete gaps surfaced during the audit:

1. The storage Worker is never tested against the PouchDB library the Obsidian
   LiveSync client actually ships, so a future client-library change could break
   syncing silently.
2. Several Obsidian vaults on one machine can point at the same remote database
   without anyone noticing. That is exactly what jammed `notes`: another vault's
   edits produced conflicts, and LiveSync cancels the push while conflicts are
   unresolved. The condition is invisible until the vault is already stuck.

## Goals

- Continuously prove protocol compatibility with the real PouchDB library.
- Detect, before damage, when two or more local vaults sync to the same remote.

## Non-goals

- No MCP work.
- No change to the storage protocol, Durable Object, backups, or deployment.
- No automatic repair: the guard reports and says what to do; it never edits a
  vault, disables sync, or touches data.

## Anti-goals

- A guard that erases or rewrites vault configuration.
- A guard that only inspects the vault's *active* remote configuration — that
  would miss a vault like `dsfsdaw`, whose `activeConfigurationId` is empty yet
  which still syncs.
- A check that needs a Cloudflare token, network access, or wakes the Durable
  Object.

## Constraints

- Cloudflare free tier; deploys run through Workers Builds.
- Node.js `^22.18.0 || >=24.11.0`; CI uses Node 24.
- Never print a secret (passwords, E2EE passphrase, ID derivation key, setup URI).
- Match repo conventions: ES-module scripts in `scripts/*.mjs`, tests named
  `test/*.test.mjs`, commands wired into `package.json`.
- Stay compatible with Obsidian LiveSync 1.0.49 with E2EE enabled.

## Approaches

### Compatibility check

- **Fold into `.github/workflows/ci.yml`** — rejected. It needs a second
  repository checkout and a PouchDB build (minutes), which would slow every push.
- **A separate, scheduled workflow ported from upstream** — chosen. It runs
  nightly, on relevant path changes, and on demand, without touching the fast
  push/PR job.

### Multi-vault guard

- **Extend `scripts/check-secrets.mjs`** — rejected. That command checks one
  vault against the live server over the network; this is an offline scan of many
  vaults with different inputs.
- **New `scripts/vault-doctor.mjs` plus its test** — chosen. It reuses the
  existing config/decrypt helpers (`livesync-config.mjs`) and stays a read-only
  diagnostic.

## Decided design

### 1. Upstream PouchDB compatibility workflow

- New file `.github/workflows/upstream-pouchdb.yml`.
- Triggers: `workflow_dispatch`, a nightly `schedule`, and `push`/`pull_request`
  limited to `package.json`, `package-lock.json`, the workflow itself, and
  `test/current-pouchdb.test.ts`.
- Steps: check out this repo as `cloudflare-obsidian-livesync`; check out
  `pouchdb/pouchdb` as its sibling `pouchdb`; build the PouchDB modules with
  `npm install && npm run build-modules`; `npm ci` here; run
  `npm run test:upstream-pouchdb` (which runs `test/current-pouchdb.test.ts`).
- Node 24 to match our CI; `permissions: contents: read`.

### 2. `npm run vault:doctor`

- New `scripts/vault-doctor.mjs`, in the style of `check-secrets.mjs`: exported
  `doctorVaults(...)`, `parseArgs`, and a `main` entry point.
- Vault sources, unioned:
  1. `--vault <dir>` (repeatable) — an explicit vault.
  2. `--root <dir>` (repeatable) — scanned one level deep for directories
     containing `.obsidian/plugins/obsidian-livesync/data.json`.
  3. Default: the Obsidian registry `~/.config/obsidian/obsidian.json`
     (overridable with `OBSIDIAN_CONFIG`) for the vaults Obsidian knows about.
- For each vault, decrypt *every* `remoteConfigurations[*].uri` **and** the legacy
  `encryptedCouchDBConnection`, and collect the `(host, database)` targets. Record
  `liveSync` and `activeConfigurationId` for the report.
- Output: one line per vault (name/path, target, LiveSync on/off), then one
  warning per `(host, database)` target used by two or more vaults, naming them.
- Exit code `1` when any target has more than one vault, else `0`. A collision
  warning suggests turning LiveSync off in the extras (as we did for the
  throwaway vaults) rather than merging.
- Never prints a secret; never writes anything.
- Wire `npm run vault:doctor`; add `test/vault-doctor.test.mjs` with temporary
  vault fixtures (reusing `test/helpers/vault-fixture.mjs` patterns).

## Left to the builder

- Exact report wording and an optional `--json` mode.
- Whether to list vaults that have no LiveSync configuration at all.
- Not in scope now: flagging a shared E2EE passphrase reached through *different*
  servers.
