# Automatic deployment with GitHub Actions

Push to `main` and the Worker redeploys itself. No terminal, no Wrangler login on
your machine. This guide covers the one-time setup, what the workflows do, how to
verify a deploy, and how to roll back.

The repository already contains the two workflows; the only thing you must supply
is a Cloudflare API token and three repository secrets.

## What runs

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| **CI** | `.github/workflows/ci.yml` | every push and pull request | Type-check and run the storage tests. Never deploys. |
| **Deploy** | `.github/workflows/deploy.yml` | push to `main`, or manual | Type-check, write the password to a temporary `.dev.vars`, run `wrangler deploy`, delete the file. |

A push to `main` therefore runs both. CI is the safety net; Deploy is what ships.

The deploy:

- uploads the storage Worker and its SQLite Durable Object class,
- binds the `obsidian-sync-backups` R2 bucket (created if missing),
- sets the `COUCHDB_PASSWORD` Worker secret from the repository secret,
- leaves the cron trigger empty — backups run from a Durable Object alarm.

It deploys **only the storage Worker**. The MCP Worker in `apps/` is not deployed.

## Prerequisites

- The repository is on GitHub and Actions are enabled (Settings → Actions → General).
- You have access to the Cloudflare account that hosts the Worker.
- A `workers.dev` subdomain is configured (dashboard → Workers & Pages → your
  Worker → Settings → Domains & Routes). The first deploy of a brand-new account
  fails without it.
- Node.js is **not** required on your machine for this flow; GitHub runs it.

## Step 1 — Create the API token

1. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**.
2. Choose **Create Custom Token** (the *Edit Cloudflare Workers* template also
   works, but then add the R2 permission below).
3. Name it something recognisable, e.g. `obsidian-livesync-github`.
4. Add these **Account** permissions:

   | Permission | Access | Why |
   | --- | --- | --- |
   | Workers Scripts | Edit | upload the Worker and Durable Object |
   | Workers R2 Storage | Edit | create/bind the backup bucket |
   | Account Settings | Read | optional; lets Wrangler resolve the account |

5. **Account Resources:** include the account that hosts the Worker (not "All
   accounts"). **Zone Resources:** none.
6. Set an expiry if you want one (a year is reasonable), then **Continue to
   summary → Create Token**.
7. Copy the token now — the dashboard shows it only once.

> Wrangler's browser login (`wrangler login`) cannot mint API tokens; it returns
> `403` on the token API. Creating the token in the dashboard is the supported
> path.

## Step 2 — Find the account ID

Either:

- open <https://dash.cloudflare.com> and copy the hex string from the URL
  (`dash.cloudflare.com/<account-id>/...`), or
- run `npx wrangler whoami` and copy the **Account ID** column.

## Step 3 — Add the repository secrets

The `gh` CLI prompts for each value, so nothing lands in your shell history:

```sh
gh secret set CLOUDFLARE_API_TOKEN  --repo <owner>/<repo>
gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/<repo>
gh secret set COUCHDB_PASSWORD      --repo <owner>/<repo>
```

Or use **Settings → Secrets and variables → Actions → New repository secret** in
the browser, with the same three names.

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from Step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the ID from Step 2 |
| `COUCHDB_PASSWORD` | the password your Obsidian clients already use |

Confirm with `gh secret list --repo <owner>/<repo>` — you should see all three
names and no values.

### Keep the password identical

`COUCHDB_PASSWORD` is uploaded as the Worker secret on **every** deploy. If it
differs from the password configured in Obsidian, the next deploy will make
every client fail with `401 Unauthorized`.

- If the Worker is already running, copy the current password from your local
  `.dev.vars` (`sed -n 's/^COUCHDB_PASSWORD=//p' .dev.vars`) or your password
  manager.
- Rotating the password later means updating this secret **and** every Obsidian
  device in the same sitting.

## Step 4 — Run the first deploy

Manual run (recommended for the first time, so you see the log):

```sh
gh workflow run Deploy --repo <owner>/<repo>
gh run watch --repo <owner>/<repo>
```

Or simply push to `main`:

```sh
git push origin main
```

Expected tail of a successful run:

```
Total Upload: ... KiB / gzip: ... KiB
Uploaded obsidian-sync (x.xx sec)
Deployed obsidian-sync triggers
  https://obsidian-sync.<subdomain>.workers.dev
```

## Step 5 — Verify

```sh
curl -u admin:'YOUR_PASSWORD' https://obsidian-sync.<subdomain>.workers.dev/vault
```

A healthy response is JSON containing `"doc_count"` and `"update_seq"`. Then in
Obsidian, make an edit and watch it reach the server:

```sh
npx wrangler tail obsidian-sync
```

You should see `POST /vault/_revs_diff 200`, `POST /vault/_bulk_docs 201`, and the
long-poll `POST /vault/_changes 200`.

## Day-2 operations

### Deploy a change

```sh
git commit -am "..." && git push origin main
```

That is the whole workflow. Re-run a failed deploy from the Actions tab
(**Re-run all jobs**) or with `gh run rerun <run-id>`.

### Roll back

Wrangler keeps the previous version; roll the Worker back without touching git:

```sh
npx wrangler rollback obsidian-sync
```

Or revert the commit and push — the workflow deploys the reverted code. Backups
in R2 are untouched by either path.

### Pause auto-deploy

```sh
gh workflow disable Deploy --repo <owner>/<repo>
gh workflow enable  Deploy --repo <owner>/<repo>   # later
```

Disabling does not remove the Worker; it only stops push-triggered deploys.
Manual runs are blocked too while disabled.

### Rotate the API token

Create a new token, `gh secret set CLOUDFLARE_API_TOKEN`, then revoke the old one
in the dashboard. Nothing else changes.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Authentication error [code: 10000]` | token lacks **Workers Scripts: Edit**, or is scoped to another account | recreate the token with the permissions above |
| `Missing COUCHDB_PASSWORD repository secret` | secret name typo or not set | `gh secret list`, then set it again |
| `R2 bucket ... does not exist` / 10000 on bucket creation | token lacks **Workers R2 Storage: Edit** | add the permission |
| `Could not find a wrangler config` | workflow run from a subdirectory, or `wrangler.jsonc` deleted | run from the repository root |
| Deploy green but Obsidian gets `401` | repository password differs from the clients' password | set the original password and redeploy, or update every client |
| `workers.dev` URL missing / `Subdomain not configured` | no account subdomain yet | dashboard → Workers & Pages → set the subdomain, re-run |
| Deploy workflow never starts | Actions disabled, or push went to a branch other than `main` | Settings → Actions → General; check the branch |
| CI red | a type error or a failing storage test | run `npm ci && npm run check:storage && npm test` locally |

The Deploy workflow writes the password to `.dev.vars` only for the duration of
the job (`chmod 600`) and deletes it in an `always()` step. Secrets are masked in
logs and are not exposed to pull requests from forks.

## Alternative: Cloudflare Workers Builds

If you would rather not create an API token, Cloudflare can build the repository
itself:

1. Dashboard → **Workers & Pages → Create → Import a repository**, pick the repo.
2. Build command: `npm ci`
3. Deploy command: `npx wrangler deploy --config wrangler.jsonc`
4. Worker → Settings → Variables and secrets → add `COUCHDB_PASSWORD`
   (and the `BACKUP_*` values already present in `wrangler.jsonc`).
5. Push to `main` to build.

Workers Builds deploys on push exactly like the Actions workflow. You lose the
CI gate and the explicit secret-file handling, and the password secret must be
managed in the dashboard instead of the repository. Do not enable both unless
you deliberately want two deploy paths racing.
