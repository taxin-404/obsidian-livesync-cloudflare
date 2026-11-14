# Obsidian LiveSync on Cloudflare Workers

A **CouchDB-compatible sync server for [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)**, running entirely on Cloudflare Workers and Durable Objects. Deploy it to your own account, point the plugin at it, and get:

- **real-time continuous sync** (`_changes` long-poll / continuous feed),
- **server-side storage while other devices are offline**,
- **end-to-end encryption** (the server stores encrypted chunks only),
- **optional daily R2 backups**, and
- **$0 on the Workers Free plan** for a single personal vault.

> **No payment card?** R2 requires a billing profile with an accepted card, but
> sync does not. You do not have to choose: `npm run deploy` checks R2 before
> deploying and uses backups when the account has them, or deploys without them
> when it does not. To force an outcome, pass `--no-r2` (never back up) or
> `--require-r2` (stop instead of deploying without backups). Full steps:
> [Deploy without R2](docs/backup-recovery.md#deploy-without-r2).

Based on [`robince/cloudflare-obsidian-livesync-mcp`](https://github.com/robince/cloudflare-obsidian-livesync-mcp) (MIT). This repository is the storage-only deployment with automation added; the MCP/search Worker is not deployed.

## What this repository adds

| Change | Why |
| --- | --- |
| Workers Builds auto-deploy | Cloudflare builds and deploys on every push to `main`, with no API token. |
| GitHub Actions CI | Type-check and storage tests on every push and pull request; never deploys. |
| Durable Object alarm for backups | Works even when the account's five free cron slots are full. The alarm calls the same `createBackup(..., true)` path as the cron handler (skips before 03:00 UTC and after the day's first success, so failures retry hourly). |
| `scripts/generate-setup-uri.sh` + `npm run setup:uri` | Produces the `obsidian://setuplivesync?...` URI needed by the plugin's onboarding wizard. |
| `docs/credentials.md` | Which values you choose, which are generated from a vault, and how to make each one. |
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
3. Build command `npm run check:storage`, deploy command `npm run deploy`,
   root `/`, preview builds off.
4. Save and push to `main`.

No Cloudflare API token is involved: Cloudflare's GitHub app is the credential,
and the build service manages its own deploy token. The dashboard Worker name
(`obsidian-sync`) already matches `name` in `wrangler.jsonc`, which Workers
Builds requires. Existing Worker secrets, including `COUCHDB_PASSWORD`, are not
touched by a deploy.

The deploy command itself checks whether R2 is available and deploys with
backups when it is, or without backups when it is not — no dashboard choice.
(Bare `npx wrangler deploy` skips that check and fails when R2 is unavailable,
so use the script.) To force an outcome, pass `--no-r2` or `--require-r2`. See
[docs/backup-recovery.md#deploy-without-r2](docs/backup-recovery.md#deploy-without-r2).

Full guide, including connecting an existing Worker, rollback, and
troubleshooting: **[docs/auto-deploy.md](docs/auto-deploy.md)**.

#### Configuration at a glance

Three kinds of value:

- **you choose** `COUCHDB_PASSWORD` — the only required entry outside the repository;
- **you may also choose** `PAGE_PASSWORD` — a separate password for the browser
  page; store it in `~/.config/obsidian-livesync/page-password` so rotation can
  still open the page;
- **a script or the plugin generates** `SETUP_URI` and `SETUP_URI_PASSPHRASE` — optional,
  vault-specific, published as a pair to make the connection page a scannable QR code;
- **the repository ships** everything else, re-applied on every deploy.

A deploy never generates or deletes a credential. Full matrix, including how to
make each secret and how to recover: **[docs/credentials.md](docs/credentials.md)**.

One value is required:

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
no extra config file and no API token. It checks whether R2 is available and
deploys with backups when it is, or without backups when it is not; existing
bucket data is never touched. Force an outcome with
`--no-r2` (never back up) or `--require-r2` (stop rather than deploy without
backups). See
[docs/backup-recovery.md#deploy-without-r2](docs/backup-recovery.md#deploy-without-r2).
(`npm run deploy:storage` is the
upstream variant that reads a local, gitignored `wrangler.deploy.jsonc`, and
`deploy:mcp` publishes the MCP Worker we do not use.)

If the account has more than one Cloudflare account, select it when Wrangler
prompts, or export `CLOUDFLARE_ACCOUNT_ID` first.

With backups enabled, the deployment creates the Worker, its SQLite Durable Object, the private R2 bucket, and the password secret. A no-R2 deployment creates the same Worker and Durable Object, but no bucket; the password secret comes from the dashboard or the `--secrets-file` you pass. The URL is printed at the end.

## Connect Obsidian (first device)

1. Install and enable **Self-hosted LiveSync** in the vault. Back the vault up first, and disable Obsidian Sync/iCloud for it.
2. Generate a Setup URI on your computer — **fresh deployments only**:
   ```sh
   LIVESYNC_HOST='https://<worker>.<subdomain>.workers.dev' \
   LIVESYNC_PASS='<the same password you added as the secret>' \
   npm run setup:uri
   ```
   It needs [Deno](https://deno.com). The password is embedded in the URI, so it must match `COUCHDB_PASSWORD`; without `LIVESYNC_PASS` the script reads it from `.dev.vars`. The script prints (and saves to `.setup-uri`, mode 600) the Setup URI, its passphrase, and the vault E2EE passphrase. **Store the E2EE passphrase in a password manager** — without it the server data and backups are unreadable.

   If the vault already has notes, do **not** run this: it invents a new vault passphrase, which cannot read the existing data. Use **Copy Setup URI** on a paired device, or `npm run rotate:password`, instead. What is chosen, generated and shipped: [docs/credentials.md](docs/credentials.md).
3. In Obsidian: LiveSync settings → **Rerun Onboarding Wizard** → *I am setting this up for the first time* → *Use a Setup URI*.
4. Paste the URI (copy it with `sed -n 's/^uri=//p' .setup-uri | wl-copy`), enter the Setup URI passphrase, **Test Settings and Continue**.
5. **Restart and Initialise Server**, confirm the overwrite warning, choose **Use this device's settings** if asked.
6. Click **Enable LiveSync** on the Quick Setup panel.

The Setup URI passphrase protects only the URI; the vault passphrase protects the notes. Keep them separate.

### Additional devices

On the configured device: LiveSync settings → **Remote Configuration → Copy Setup URI** (pick a new URI passphrase). Use that on the next device: *Add another device* → *Use a Setup URI*. Do not reuse the provisioning URI for every device.

### Connection details page

A browser opening the Worker URL is asked for `PAGE_PASSWORD`, or for
`COUCHDB_PASSWORD` when `PAGE_PASSWORD` is not set, before the page shows the
setup URI and its passphrase (or, when those secrets are not bound, the URL,
database, username and password). To use a separate page password, set the
`PAGE_PASSWORD` secret and keep the same value in
`~/.config/obsidian-livesync/page-password` (mode 600); rotation leaves it
unchanged. There is no session or cookie, so every visit asks again. If neither
password exists the page returns 503 instead of exposing anything. Requests from the plugin, PouchDB or curl do not ask for HTML and
still get the authenticated CouchDB surface.

The server password, the setup URI and its passphrase have to agree, or the
phones and the page break together. Never edit one of them on its own — rotate
all three and the local vault in one command:

```sh
npm run rotate:password -- --vault ~/Documents/notes
npm run check:secrets -- --vault ~/Documents/notes
```

`rotate:password` regenerates every dependent secret, updates the vault and
verifies the result; every paired device then re-pairs from the page.
`check:secrets` prints one line per link and names the one that drifted, without
printing a secret. The complete credential matrix is in
[docs/credentials.md](docs/credentials.md). If Wrangler can see more than one
Cloudflare account, add
`--account-id <id>` to `rotate:password` or export `CLOUDFLARE_ACCOUNT_ID`; if
the Worker is not named `live`, add `--worker <name>`. Both commands read a
separate page password from `~/.config/obsidian-livesync/page-password` when
`PAGE_PASSWORD` is set; pass `--page-password-file` to point elsewhere.

If the password was changed outside this tool — in the Cloudflare dashboard, for
example — no device can authenticate and the page cannot be opened, so a normal
rotation has no profile to start from. Rebuild all three secrets from the vault
instead:

```sh
npm run rotate:password -- --vault ~/Documents/notes --rebuild
npm run check:secrets -- --vault ~/Documents/notes
```

`--rebuild` refuses while the saved password still works, takes the new-device
profile from the vault's own settings, keeps the setup URI under the Worker's
5.1 kB secret limit, and gives every device the new setup URI and passphrase.

## Backups and restore

- Daily after **03:00 UTC** via a Durable Object alarm; 30 daily, 8 weekly, 24 monthly recovery points in R2.
- Manual backup / inspect:
  ```sh
  curl -u admin:PASSWORD -X POST https://<worker>/_backup
  curl -u admin:PASSWORD https://<worker>/_backup
  curl -u admin:PASSWORD https://<worker>/_backup/status
  ```
- Restore: see [`docs/backup-recovery.md`](docs/backup-recovery.md) (`POST /_backup/restore`).
- Health: `GET /_up` needs no credentials and includes the newest backup's age:
  ```sh
  curl -s https://<worker>/_up
  # {"status":"ok","backup":{"lastSuccess":"2026-11-13T08:45:49.884Z","ageHours":0.2,"overdue":false}}
  ```
  `overdue` turns true when the newest completed backup is more than 26 hours old.
  The check reads R2 only, so polling it does not wake an idle Durable Object.
  `GET /_backup/status` (authenticated) additionally shows the last attempt and
  any error message.

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

Every client that uses the same URL and database name shares one Durable Object, so extra devices or extra vaults add requests, not a second duration charge. The duration figure above is for that single object being kept hot by continuous LiveSync. If it approaches the allowance, switch clients to **Periodic and Events → 60 s**, which lets the Durable Object hibernate.

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

### “Error during vault initialisation process.” after choosing the fetch options

Self-hosted LiveSync 1.0.50's **Fetch everything** (and the fast-setup fetch)
checks the remote feature document with a `GET` request that puts the keys in
the query string:

```
GET /vault/_all_docs?keys=["obsydian_livesync_version"]&include_docs=true
```

CouchDB accepts `keys` both as a `POST` body field and as a query parameter.
Older builds of this server only read the body form, so the probe returned
every document, the plugin rejected the response as invalid, and the fetch
stopped before it changed anything. The server now accepts the query form; no
plugin setting needs to change. If the fetch flag (`flag_fetch.md`) is still
present afterwards, restart Obsidian and choose **Continue with these
choices** to run it again.

### A second vault does not sync: “Remote database is locked”

If a rebuild, reset or interrupted onboarding ran on one device, the plugin
marks the remote database as locked and records only that device's node ID in
`_local/obsydian_livesync_milestone`. Any other vault is then refused with
**Remote database is locked** and replication never starts — the second vault
looks configured but stays empty.

Check the server:

```sh
curl -u admin:PASSWORD https://<worker>/vault/_local/obsydian_livesync_milestone
```

`"locked": true` with a single entry in `accepted_nodes` is the cause. On a
device that is already accepted (or after confirming the second vault holds
nothing you need), open LiveSync settings and use **Unlock the remote
database**, or in the locked dialog choose **Unlock**. The next sync adds each
device's node ID to `accepted_nodes` automatically; `"locked": false` accepts
new devices without further steps.

Do not unlock a database that is genuinely mid-rebuild on another device —
finish or reset that rebuild first, then unlock.

## Operations

```sh
npx wrangler tail obsidian-sync          # live logs
npm run rotate:password -- --vault ~/Documents/notes   # rotate every dependent secret
npm run check:secrets -- --vault ~/Documents/notes     # find the link that drifted
npx wrangler delete obsidian-sync        # tear down Worker
npx wrangler r2 bucket delete obsidian-sync-backups
```

Changing `BACKUP_ENABLED` to `"false"` and redeploying with the deploy script removes the R2 binding and cron; sync keeps working (keep your own backups). Without a custom config, `npm run deploy:no-r2` does the same thing. See [deploy without R2](docs/backup-recovery.md#deploy-without-r2).

### Where the database runs

The Worker itself runs in the Cloudflare data center closest to each request.
The SQLite Durable Object that holds the database is created once and does not
move, so every request is forwarded to that one location. New objects are hinted
to `apac` in `src/placement.ts`; hints are best effort and are ignored for an
object that already exists. Cloudflare does not place Durable Objects in every
country (including Bangladesh), so Asia-Pacific is the nearest available region.
From Dhaka the extra hop to the database is roughly 50–60 ms.

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
