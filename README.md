# Obsidian LiveSync on Cloudflare Workers

A **CouchDB-compatible sync server for [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)**, running entirely on Cloudflare Workers and Durable Objects. Deploy it to your own account, point the plugin at it, and get:

- **real-time continuous sync** (`_changes` long-poll / continuous feed),
- **server-side storage while other devices are offline**,
- **end-to-end encryption** (the server stores encrypted chunks only),
- **daily R2 backups**, and
- **$0 on the Workers Free plan** for a single personal vault.

Based on [`robince/cloudflare-obsidian-livesync-mcp`](https://github.com/robince/cloudflare-obsidian-livesync-mcp) (MIT). This repository is the storage-only deployment with automation added; the MCP/search Worker is not deployed.

## What this repository adds

| Change | Why |
| --- | --- |
| Workers Builds auto-deploy | Cloudflare builds and deploys on every push to `main`, with no API token. |
| GitHub Actions CI | Type-check and storage tests on every push and pull request; never deploys. |
| Durable Object alarm for backups | Works even when the account's five free cron slots are full. The alarm calls the same `createBackup(..., true)` path as the cron handler (skips before 03:00 UTC and after the day's first success, so failures retry hourly). |
| `scripts/generate-setup-uri.sh` | Produces the `obsidian://setuplivesync?...` URI needed by the plugin's onboarding wizard. |
| `scripts/upstream-sync.mjs` + `upstream.json` | Shows what changed upstream since the pinned snapshot and ports single files. See [docs/upstream-sync.md](docs/upstream-sync.md). |
| `wrangler.jsonc` with `crons: []` | The alarm replaces the cron trigger; add a cron only if you prefer it. |

## How it works

```
Obsidian (LiveSync)  ──HTTPS──>  Worker (obsidian-sync)
                                   │  CouchDB subset: _bulk_docs, _revs_diff,
                                   │  _changes (longpoll/continuous), _local, ...
                                   ▼
                            Durable Object "PouchDatabase"
                                   │  SQLite: document-store, revisions, chunks
                                   ▼
                              R2 bucket: daily backups
```

One Durable Object per database (one vault). The plugin's E2EE passphrase encrypts note contents and internal metadata client-side.

## Deploy

### Option A — Workers Builds (no API token)

Connect the repository once, then every push to `main` builds and deploys.

1. Dashboard → **Workers & Pages** → **obsidian-sync** → **Settings → Builds → Connect**
   (for a fresh install: **Create application → Continue with GitHub**).
2. Repository `taxin-404/obsidian-livesync-cloudflare`, branch `main`.
3. Build command `npm run check:storage`, deploy command `npx wrangler deploy`,
   root `/`, preview builds off.
4. Save and push to `main`.

No Cloudflare API token is involved: Cloudflare's GitHub app is the credential,
and the build service manages its own deploy token. The dashboard Worker name
(`obsidian-sync`) already matches `name` in `wrangler.jsonc`, which Workers
Builds requires. Existing Worker secrets, including `COUCHDB_PASSWORD`, are not
touched by a deploy.

Full guide, including connecting an existing Worker, rollback, and
troubleshooting: **[docs/auto-deploy.md](docs/auto-deploy.md)**.

#### Configuration at a glance

Exactly one value is entered outside the repository:

| Name | Type | Where | Value |
| --- | --- | --- | --- |
| `COUCHDB_PASSWORD` | Secret | Worker → Settings → Variables and secrets | the password Obsidian already uses |

Everything else ships in `wrangler.jsonc` and is applied on every deploy:

| Name | Value | Purpose |
| --- | --- | --- |
| `COUCHDB_USERNAME` | `admin` | basic-auth user |
| `CORS_ORIGINS` | `app://obsidian.md,capacitor://localhost,http://localhost` | allowed browser origins |
| `BACKUP_ENABLED` | `"true"` | scheduled (alarm) R2 backups |
| `BACKUP_DATABASE` | `vault` | database being backed up |
| `BACKUP_DAILY` | `30` | days of history kept |
| `BACKUP_WEEKLY` | `8` | weeks of history kept |
| `BACKUP_MONTHLY` | `24` | months of history kept |

`POUCH_DATABASES` (Durable Object) and `BACKUP_BUCKET` (R2, `obsidian-sync-backups`)
are bindings created by the deploy — not values to enter. Do not add the plain
variables in the dashboard: a deploy resets them to the file. Optional build-time
variable: `NODE_VERSION=24` if you do not want to rely on `.nvmrc`. Details:
[docs/auto-deploy.md#environment-what-to-add-and-what-not-to](docs/auto-deploy.md#environment-what-to-add-and-what-not-to).

### Option B — Local deploy

```sh
git clone <this repo> && cd <repo>
npm ci
cp .dev.vars.example .dev.vars        # set a strong COUCHDB_PASSWORD
npx wrangler login
npm run deploy -- --secrets-file .dev.vars
```

`npm run deploy` publishes the storage Worker only, from `wrangler.jsonc` —
no extra config file and no API token. (`npm run deploy:storage` is the
upstream variant that reads a local, gitignored `wrangler.deploy.jsonc`, and
`deploy:mcp` publishes the MCP Worker we do not use.)

If the account has more than one Cloudflare account, select it when Wrangler
prompts, or export `CLOUDFLARE_ACCOUNT_ID` first.

The deployment creates the Worker, its SQLite Durable Object, the private R2 bucket, and the password secret. The URL is printed at the end.

## Connect Obsidian (first device)

1. Install and enable **Self-hosted LiveSync** in the vault. Back the vault up first, and disable Obsidian Sync/iCloud for it.
2. Generate a Setup URI on your computer:
   ```sh
   LIVESYNC_HOST='https://<worker>.<subdomain>.workers.dev' ./scripts/generate-setup-uri.sh
   ```
   It needs [Deno](https://deno.com). The script prints (and saves to `.setup-uri`, mode 600) the Setup URI, its passphrase, and the vault E2EE passphrase. **Store the E2EE passphrase in a password manager** — without it the server data and backups are unreadable.
3. In Obsidian: LiveSync settings → **Rerun Onboarding Wizard** → *I am setting this up for the first time* → *Use a Setup URI*.
4. Paste the URI (copy it with `sed -n 's/^uri=//p' .setup-uri | wl-copy`), enter the Setup URI passphrase, **Test Settings and Continue**.
5. **Restart and Initialise Server**, confirm the overwrite warning, choose **Use this device's settings** if asked.
6. Click **Enable LiveSync** on the Quick Setup panel.

The Setup URI passphrase protects only the URI; the vault passphrase protects the notes. Keep them separate.

### Additional devices

On the configured device: LiveSync settings → **Remote Configuration → Copy Setup URI** (pick a new URI passphrase). Use that on the next device: *Add another device* → *Use a Setup URI*. Do not reuse the provisioning URI for every device.

### Connection details page

Opening the Worker URL in a browser shows the URL, database name, username and
password to paste into LiveSync. The page answers `GET /` for requests that ask
for HTML, before authentication; requests from the plugin, PouchDB or curl
(`Accept: application/json` or none) still get the authenticated CouchDB
surface. Anyone with the page link can read those credentials, so share the
link only with people who should have the password.

## Backups and restore

- Daily after **03:00 UTC** via a Durable Object alarm; 30 daily, 8 weekly, 24 monthly recovery points in R2.
- Manual backup / inspect:
  ```sh
  curl -u admin:PASSWORD -X POST https://<worker>/_backup
  curl -u admin:PASSWORD https://<worker>/_backup
  curl -u admin:PASSWORD https://<worker>/_backup/status
  ```
- Restore: see [`docs/backup-recovery.md`](docs/backup-recovery.md) (`POST /_backup/restore`).

If you prefer a real cron trigger (for example on a dedicated account with free slots), add it back in `wrangler.jsonc`:
```jsonc
"triggers": { "crons": ["0 * * * *"] }
```
Both paths are idempotent.

## Free-tier notes

| Resource | Free allowance | This workload |
| --- | --- | --- |
| DO duration | 13,000 GB-s/day | ~11,000 GB-s/day for one vault kept hot by continuous sync |
| Requests | 100k/day (Workers and DO) | a few thousand/day for 2–3 devices |
| R2 | 10 GB-month | gzipped JSONL table exports; small |
| Cron triggers | 5/account | none used (alarm instead) |

One vault per account is the safe assumption. If sync starts failing at the quota, switch clients to **Periodic and Events → 60 s**, which lets the Durable Object hibernate.

## Troubleshooting

### “Replication failed on an unattended path.” in the status bar

With plugin **1.0.49**, this appears when **Sync on save**, **Sync on editor save** or **Sync on file open** is enabled next to continuous LiveSync. Those toggles schedule an extra one-shot replication; the plugin rejects it because the continuous replication is already running, and reports that rejection as a failure. Nothing is lost — continuous replication has already sent the change, and every request still succeeds.

The plugin's own **Synchronization Preset** (LiveSync settings → *Synchronization Preset* → **LiveSync**) avoids it by turning all event triggers off. Keep those three toggles off:

```jsonc
"liveSync": true,
"syncOnSave": false,
"syncOnEditorSave": false,
"syncOnFileOpen": false
```

If you prefer the event-driven style, enable **Synchronization Preset → Periodic with batch** instead and turn continuous LiveSync off; you lose real-time push, but the DO can hibernate between syncs.

## Operations

```sh
npx wrangler tail obsidian-sync          # live logs
npx wrangler secret put COUCHDB_PASSWORD --config wrangler.jsonc   # rotate password
npx wrangler delete obsidian-sync        # tear down Worker
npx wrangler r2 bucket delete obsidian-sync-backups
```

Changing `BACKUP_ENABLED` to `"false"` and redeploying with the deploy script removes the R2 binding and cron; sync keeps working (keep your own backups).

## Updating from upstream

This repository is a snapshot of
[`robince/cloudflare-obsidian-livesync-mcp`](https://github.com/robince/cloudflare-obsidian-livesync-mcp)
at `a14fc4b` plus local changes, so there is no shared git history to merge. A
pin in `upstream.json` records what we already have, and a script shows what is
new:

```sh
npm run upstream:check                 # commits and files changed upstream
npm run upstream:diff  -- src/foo.ts   # the upstream patch for one file
npm run upstream:apply -- src/foo.ts   # apply it if we have not edited that file
npm run upstream:accept -- --yes       # move the pin after porting and testing
```

Files we have also changed are marked *port by hand*; MCP-only files
(`apps/cloudflare-obsidian-mcp/`) are marked as safe to skip for this
storage-only deployment. Full workflow and decision table:
**[docs/upstream-sync.md](docs/upstream-sync.md)**.

Local changes are limited to `src/pouch-database.ts` (alarm), `wrangler.jsonc`
(no cron), the workflows, `.nvmrc`, the setup URI script, and the deployment
docs.

## Security

- The Worker exposes the CouchDB subset the plugin needs, protected by basic auth (`COUCHDB_USERNAME` / `COUCHDB_PASSWORD`).
- E2EE is mandatory in practice: keep `encrypt` enabled in the plugin and never commit `.dev.vars`, `.setup-uri`, or `wrangler.deploy.jsonc`.
- CORS defaults allow Obsidian desktop and mobile origins; change `CORS_ORIGINS` if you proxy the Worker.

## License

MIT, retaining the upstream copyright notice. See [`LICENSE`](LICENSE).
