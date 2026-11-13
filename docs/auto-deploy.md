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
  3. npx wrangler deploy     (deploy command, uses wrangler.jsonc)
        │
        ▼
Worker obsidian-sync  +  Durable Object  +  R2 binding
```

The deploy command is the same `wrangler deploy` you would run locally; the
build service supplies the authentication. The Worker's existing secrets are
not removed or rewritten by a deploy.

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
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` |
   | Preview builds | off |

6. Save, then push a commit to `main` (or use **Retry build**).

For a brand-new installation, the equivalent entry point is **Workers & Pages →
Create application → Continue with GitHub**; the build settings are the same.

### Why these values

- **`npm run check:storage`** runs `tsc --noEmit`. A type error fails the build
  before it can break the live Worker. Leave the field empty if you prefer a
  pure deploy.
- **`npx wrangler deploy`** reads `wrangler.jsonc`, which already names the
  Worker, its Durable Object class, the R2 binding, and `crons: []`.
- **No `npm ci` in the build command** — Cloudflare runs it automatically before
  the build.
- **Node 24** comes from the committed `.nvmrc`; Workers Builds reads it. If you
  prefer, set a build variable `NODE_VERSION=24` instead. The repository needs
  Node 22.18+ or 24.11+.

## First build

The build log ends with something like:

```
Total Upload: ... KiB / gzip: ... KiB
Uploaded obsidian-sync (x.xx sec)
Deployed obsidian-sync triggers
  https://obsidian-sync.tes1ing.workers.dev
```

The first build deploys the same code that is running now, so Obsidian keeps
working. The `COUCHDB_PASSWORD` Worker secret is left in place.

## Verify

```sh
curl -u admin:'YOUR_PASSWORD' https://obsidian-sync.tes1ing.workers.dev/vault
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

Builds never see the password. Change it on the Worker
(**Settings → Variables and secrets**) or with
`npx wrangler secret put COUCHDB_PASSWORD`, then update every Obsidian device in
the same sitting.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The name in your Wrangler configuration file ... must match` | dashboard Worker name ≠ `wrangler.jsonc` `name` | rename one to `obsidian-sync` |
| Repository not listed when connecting | Cloudflare GitHub app lacks access to the private repo | GitHub → Settings → Applications → Cloudflare Workers → Configure → add the repo |
| Build fails at `npm ci` with an engine error | build image ignored `.nvmrc` | set build variable `NODE_VERSION=24` in Settings → Builds |
| `Missing script: "build"` | build command left as `npm run build` | use `npm run check:storage` or leave it empty |
| Build succeeds, site unchanged | build ran on another branch | check the branch in Settings → Builds |
| Preview builds fail on a side branch | preview command `npx wrangler preview` is not used by this project | turn preview builds off |
| Obsidian returns `401` after a deploy | the Worker password was changed | restore the old secret, or update every client |
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
