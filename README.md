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
| GitHub Actions CI + deploy workflows | Push to `main` deploys the Worker. |
| Durable Object alarm for backups | Works even when the account's five free cron slots are full. The alarm calls the same `createBackup(..., true)` path as the cron handler (skips before 03:00 UTC and after the day's first success, so failures retry hourly). |
| `scripts/generate-setup-uri.sh` | Produces the `obsidian://setuplivesync?...` URI needed by the plugin's onboarding wizard. |
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

### Option A — GitHub Actions (included)

1. Create a Cloudflare **API token**: dashboard → *My Profile → API Tokens → Create Token*.
   Use the **Edit Cloudflare Workers** template and add:
   - `Workers R2 Storage: Edit` (backup bucket provisioning)
   - `Account Settings: Read` (optional, for account discovery)
   Scope it to your account only.
2. Add repository secrets (Settings → Secrets and variables → Actions):
   ```sh
   gh secret set CLOUDFLARE_API_TOKEN --body "<token>"
   gh secret set CLOUDFLARE_ACCOUNT_ID --body "<account id>"
   gh secret set COUCHDB_PASSWORD   --body "<a strong password>"
   ```
3. Push to `main` (or run the **Deploy** workflow manually). The workflow runs the type check, deploys the Worker, its SQLite Durable Object class, R2 bucket, and the `COUCHDB_PASSWORD` secret, then prints the deployed URL.

### Option B — Cloudflare Workers Builds

No API token needed; Cloudflare builds on push.

1. Dashboard → *Workers & Pages → Create → Import a repository* → pick this repo.
2. Build command: `npm ci` — Deploy command: `npx wrangler deploy --config wrangler.jsonc`.
3. Add the Worker secret `COUCHDB_PASSWORD` (Settings → Variables and secrets). Deploying does not remove existing secrets.
4. Push to `main` to trigger a build.

### Option C — Local deploy

```sh
git clone <this repo> && cd <repo>
npm ci
cp .dev.vars.example .dev.vars        # set a strong COUCHDB_PASSWORD
npx wrangler login
npm run deploy:storage -- --secrets-file .dev.vars
```

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

```sh
git remote add upstream https://github.com/robince/cloudflare-obsidian-livesync-mcp.git
git fetch upstream
git merge upstream/main
```

Local changes are limited to `src/pouch-database.ts` (alarm), `wrangler.jsonc` (no cron), workflows, and the setup URI script.

## Security

- The Worker exposes the CouchDB subset the plugin needs, protected by basic auth (`COUCHDB_USERNAME` / `COUCHDB_PASSWORD`).
- E2EE is mandatory in practice: keep `encrypt` enabled in the plugin and never commit `.dev.vars`, `.setup-uri`, or `wrangler.deploy.jsonc`.
- CORS defaults allow Obsidian desktop and mobile origins; change `CORS_ORIGINS` if you proxy the Worker.

## License

MIT, retaining the upstream copyright notice. See [`LICENSE`](LICENSE).
