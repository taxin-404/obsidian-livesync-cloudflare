# Automatic deployment with Workers Builds

Push to `main` and Cloudflare rebuilds and redeploys the Worker. There is **no
Cloudflare API token** to create: Cloudflare's own GitHub app is the credential,
and Workers Builds generates and stores its own deploy token.

This is the same mechanism used by the other Workers on this account
(`terabox-webdav-worker`), just attached to the existing `obsidian-sync` Worker
so its URL and database survive.

## How it works

```
git push origin main
        │
        ▼
Cloudflare Workers Builds
  1. npm ci                  (Cloudflare installs dependencies)
  2. npm run check:storage   (type-check, optional build command)
  3. npm run deploy          (deploy command, uses wrangler.jsonc;
                              checks R2 and adjusts backups)
        │
        ▼
Worker obsidian-sync  +  Durable Object  +  R2 binding
```

The deploy command wraps `wrangler deploy` and also checks whether the account
can use R2: it deploys with backups when it can, and without the R2 binding and
with backups off when it cannot. The build service supplies the authentication,
and the Worker's existing secrets are not removed or rewritten by a deploy.

If the account cannot enable R2 (Cloudflare requires a billing profile with an
accepted card), `npm run deploy` detects that and deploys the same Worker
without backups; sync keeps working. To force no backups, use
`node scripts/deploy-storage.mjs wrangler.jsonc "" --no-r2`; to stop rather than
deploy without backups, add `--require-r2`. See
[deploy without R2](backup-recovery.md#deploy-without-r2).

## Prerequisites

- The Worker already exists in the account (`obsidian-sync`), or you are happy
  to create one with the repository.
- The Cloudflare GitHub app can see the repository. For a private repo, grant it
  access during the connect flow (GitHub → Settings → Applications →
  Cloudflare Workers → Configure → Repository access).
- `wrangler.jsonc` is at the repository root and its `"name"` is `obsidian-sync`.

### The name must match

Workers Builds requires the Worker name in the dashboard to equal `name` in the
Wrangler configuration. Ours does:

| Where | Value |
| --- | --- |
| Dashboard Worker | `obsidian-sync` |
| `wrangler.jsonc` | `"name": "obsidian-sync"` |

If you rename either one, the build fails with:

```
✘ [ERROR] The name in your Wrangler configuration file (...) must match the name of your Worker.
```

## Connect the existing Worker

Do this in the dashboard for `obsidian-sync` — **do not create a second Worker**,
or you will start with an empty database and a different URL.

1. Open <https://dash.cloudflare.com> → **Workers & Pages** → **obsidian-sync**.
2. **Settings → Builds → Connect**.
3. Choose **GitHub**, authorise/refresh the app if asked, and select
   `taxin-404/obsidian-livesync-cloudflare`.
4. Branch: `main`.
5. Build settings:

   | Field | Value |
   | --- | --- |
   | Build command | `npm run check:storage` |
   | Deploy command | `npm run deploy` (checks R2; see below) |
   | Root directory | `/` |
   | Preview builds | off |

6. Save, then push a commit to `main` (or use **Retry build**).

For a brand-new installation, the equivalent entry point is **Workers & Pages →
Create application → Continue with GitHub**; the build settings are the same.

### Why these values

- **`npm run check:storage`** runs `tsc --noEmit`. A type error fails the build
  before it can break the live Worker. Leave the field empty if you prefer a
  pure deploy.
- **`npm run deploy`** runs `scripts/deploy-storage.mjs`, which checks R2 and
  then deploys `wrangler.jsonc` — the Worker name, its Durable Object class, the
  R2 binding, and `crons: []`. It deploys with backups when R2 is available and
  without the binding when it is not. Accounts that always want no backups can
  use `node scripts/deploy-storage.mjs wrangler.jsonc "" --no-r2`; `--require-r2`
  stops instead of deploying without backups. Bare `npx wrangler deploy` skips
  the check and fails when R2 is absent.
- **No `npm ci` in the build command** — Cloudflare runs it automatically before
  the build.
- **Node 24** comes from the committed `.nvmrc`; Workers Builds reads it. If you
  prefer, set a build variable `NODE_VERSION=24` instead. The repository needs
  Node 22.18+ or 24.11+.

## Environment: what to add (and what not to)

There are three kinds of configuration. Only one of them is typed into the
dashboard.

**Checklist:** dashboard → **Settings → Variables and secrets** contains exactly
one entry, `COUCHDB_PASSWORD` (type: Secret). Everything else is either in
`wrangler.jsonc` or created by the deploy.

### 1. The only secret you must add

| Name | Value | Where |
| --- | --- | --- |
| `COUCHDB_PASSWORD` | the password your Obsidian devices use | Worker → **Settings → Variables and secrets** → add as **Secret** |

That is the complete list of dashboard entries. The existing `obsidian-sync`
Worker already has it, so connecting Workers Builds requires **no new secret at
all**. If you are creating a fresh Worker, add it once before the first sync.

Adding the same password as a plain *variable* instead of a *secret* would
expose it in the dashboard and in exports; use the Secret checkbox.

### 2. Plain variables already in `wrangler.jsonc`

These are deployed from the file on every build. Do **not** add them in the
dashboard: a deploy overwrites dashboard variables with the file's values, and
any dashboard-only variable in this Worker is removed because `wrangler.jsonc`
does not set `keep_vars`.

| Name | Value | Purpose |
| --- | --- | --- |
| `COUCHDB_USERNAME` | `admin` | Basic-auth user Obsidian sends |
| `CORS_ORIGINS` | `app://obsidian.md,capacitor://localhost,http://localhost` | Origins allowed by CORS |
| `BACKUP_ENABLED` | `"true"` | Enables the R2 backup path and its alarm |
| `BACKUP_DATABASE` | `vault` | Which database is backed up |
| `BACKUP_DAILY` | `30` | Distinct days of history preserved |
| `BACKUP_WEEKLY` | `8` | Distinct weeks of history preserved |
| `BACKUP_MONTHLY` | `24` | Distinct months of history preserved |

To change any of them, edit `wrangler.jsonc`, commit, and push — that is the
deploy.

`CORS_ORIGINS` matters if you put the Worker behind a custom domain or a proxy:
add that origin (comma-separated). `*` is accepted but lets any web page call
the database, so avoid it.

`BACKUP_*` retention values must be integers between 1 and 10000. The newest
backup in each of the last N days, weeks, and months is kept and the rest are
pruned. Setting `BACKUP_ENABLED` to `"false"` stops the scheduled (alarm)
backups. Manual `POST /_backup` still works while the R2 binding is attached —
use `scripts/deploy-storage.mjs` locally if you also want the binding removed.

### 3. Bindings created by the deploy

Not environment variables and not editable in the dashboard:

| Binding | Type | Created from |
| --- | --- | --- |
| `POUCH_DATABASES` | Durable Object (`PouchDatabase`) | `durable_objects` + `migrations` in `wrangler.jsonc` |
| `BACKUP_BUCKET` | R2 bucket `obsidian-sync-backups` | `r2_buckets` in `wrangler.jsonc`; created if missing |

### Local development only

`.dev.vars` (gitignored, mode 600) needs the same secret:

```sh
COUCHDB_PASSWORD=...
```

`.dev.vars.example` is the template. Builds and production never read this file.

### The `dev` environment

`wrangler.jsonc` also defines an optional `dev` environment that deploys a
separate Worker named `obsidian-sync-dev`. It has its own database and needs its
own `COUCHDB_PASSWORD`; it is not used by Workers Builds, which targets the
top-level `obsidian-sync` Worker.

### Test-only names you will see in the code

Ignore these; they are read by staging and E2E scripts, never by the deployed
Worker:

| Prefix | Used by |
| --- | --- |
| `STAGING_*` | `scripts/` staging probes (CouchDB URL, MCP URL, tokens, disposable-vault guard) |
| `E2E_*` | Obsidian end-to-end harness (`E2E_OBSIDIAN_CLI_TIMEOUT_MS`, `E2E_OBSIDIAN_DIAGNOSTICS_DIR`) |

Setting any of them on the production Worker has no effect.

## First build

The build log ends with something like:

```
Total Upload: ... KiB / gzip: ... KiB
Uploaded obsidian-sync (x.xx sec)
Deployed obsidian-sync triggers
  https://obsidian-sync.<account-subdomain>.workers.dev
```

The first build deploys the same code that is running now, so Obsidian keeps
working. The `COUCHDB_PASSWORD` Worker secret is left in place.

## Verify

```sh
curl -u admin:'YOUR_PASSWORD' https://obsidian-sync.<account-subdomain>.workers.dev/vault
```

Expect JSON with `"doc_count"` and `"update_seq"`. For live request logs:

```sh
npx wrangler tail obsidian-sync
```

An edit in Obsidian should produce `POST /vault/_revs_diff 200`,
`POST /vault/_bulk_docs 201`, and the long-poll `POST /vault/_changes 200`.

## Day-2 operations

### Deploy a change

```sh
git commit -am "..." && git push origin main
```

That is the whole workflow. The build appears under the Worker's **Deployments**
tab.

### Roll back

Either redeploy an older commit from the dashboard (**Deployments → … → Roll
back**), or from a machine with Wrangler logged in:

```sh
npx wrangler rollback obsidian-sync
```

Neither touches the R2 backups.

### Pause automatic deploys

Worker → **Settings → Builds → Disconnect**. The Worker stays up with its current
code; re-connect when you want automatic deploys again.

### Change the branch

**Settings → Builds** → edit the branch. Useful if you want `main` to stay
stable and deploy from `production`.

### Rotate the password

Builds never see the password. Editing `COUCHDB_PASSWORD` under **Settings →
Variables and secrets** changes only one of the four places that must agree, so
the phones, the setup page and the desktop vault break at once. Rotate from a
checkout instead:

```sh
npm run rotate:password -- --vault ~/Documents/notes
npm run check:secrets -- --vault ~/Documents/notes
```

`rotate:password` regenerates the server password, the setup URI and its
passphrase, writes the new password to
`~/.config/obsidian-livesync/server-password`, rewrites the vault's encrypted
connection, and verifies the change with the old and the new password. Quit
Obsidian first. Every paired device must re-pair from the setup URI shown on the
gated page; there is no grace period for the old password. The full list of
chosen, generated and shipped values, with the command for each:
[docs/credentials.md](credentials.md).

`check:secrets` prints one line per link — server password, setup page gate,
setup URI password, setup URI device profile, vault connection — and exits 1 on
drift. It never prints a secret.

If the Worker's password was changed outside this tool (the dashboard, a build
secret edit, or a lost value), no device can authenticate and the gated page
cannot be opened. A normal rotation needs that page as its profile, so rebuild
all three secrets from the vault instead:

```sh
npm run rotate:password -- --vault ~/Documents/notes --rebuild
npm run check:secrets -- --vault ~/Documents/notes
```

`--rebuild` verifies first that the saved password really is rejected, builds a
minimal new-device profile from the vault's encryption settings, and replaces
`SETUP_URI`, `SETUP_URI_PASSPHRASE` and `COUCHDB_PASSWORD` together. It has no
old values to restore, so it reports exactly what it could not verify instead
of pretending to roll back.

Wrangler needs to know which account owns the Worker when the login can see more
than one: add `--account-id <id>` to `rotate:password`, or export
`CLOUDFLARE_ACCOUNT_ID` first. Without it the preflight fails before anything is
written. If the Worker is not named `live`, pass `--worker <name>`.

Both commands use the page gate stored in `~/.config/obsidian-livesync/page-password`
when `PAGE_PASSWORD` is set, and fall back to `COUCHDB_PASSWORD` when it is not.
Pass `--page-password-file` to point at a different file. Rotation reads the
page with that password and leaves `PAGE_PASSWORD` unchanged.

Local writes are staged first and renamed into place after verification. The
verification retries for about ten seconds, because a Worker secret can take a
moment to reach every isolate. If a run is ever interrupted, check
`<password-file>.tmp` and `data.json.tmp` next to the real files before retrying:
one of them may already hold the new password or the encrypted settings.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The name in your Wrangler configuration file ... must match` | dashboard Worker name ≠ `wrangler.jsonc` `name` | rename one to `obsidian-sync` |
| Repository not listed when connecting | Cloudflare GitHub app lacks access to the private repo | GitHub → Settings → Applications → Cloudflare Workers → Configure → add the repo |
| Build fails at `npm ci` with an engine error | build image ignored `.nvmrc` | set build variable `NODE_VERSION=24` in Settings → Builds |
| `Missing script: "build"` | build command left as `npm run build` | use `npm run check:storage` or leave it empty |
| Build succeeds, site unchanged | build ran on another branch | check the branch in Settings → Builds |
| Preview builds fail on a side branch | preview command `npx wrangler preview` is not used by this project | turn preview builds off |
| Obsidian returns `401` after a deploy | the Worker password was changed | `npm run check:secrets -- --vault <path>`, then `npm run rotate:password -- --vault <path>`; every device re-pairs |
| Every device gets `401` and the setup page will not open | the password was changed outside the tool, so no profile can be read | `npm run rotate:password -- --vault <path> --rebuild`, then re-pair every device |
| Builds stuck queued | account build concurrency | wait, or cancel the older build |

## Difference from GitHub Actions

An earlier revision of this repository shipped a GitHub Actions deploy workflow.
That path needs a `CLOUDFLARE_API_TOKEN` repository secret because GitHub's
runners have no session in your Cloudflare account. Workers Builds needs no
token, so it is the only automatic path now; `.github/workflows/ci.yml` still
runs the type check and tests on GitHub, but it never deploys.

If you ever do want a third-party CI deploy, create an account-scoped token with
`Workers Scripts: Edit` and `Workers R2 Storage: Edit`, store it as
`CLOUDFLARE_API_TOKEN`, and run
`node scripts/deploy-storage.mjs wrangler.jsonc "" --secrets-file .dev.vars`.
