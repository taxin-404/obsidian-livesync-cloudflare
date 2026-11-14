# Deployment

This guide deploys the Cloudflare PouchDB storage Worker to your own Cloudflare
account. The optional MCP Worker can be deployed alongside it after its GitHub
OAuth settings are configured.

## First-time checklist

1. Choose a Worker name. Any name works; this repo ships with `live` as the
   starting name.
2. Make sure that name is in `wrangler.jsonc` `"name"`: the button writes it
   there, and a local or fork deploy replaces `live` with it.
3. Choose `COUCHDB_PASSWORD`; save it for Obsidian.
4. Deploy with the button or the local command below.
5. Connect Obsidian LiveSync to the printed `workers.dev` URL.

## Deploy from your computer

Use Wrangler to deploy from a local checkout:

1. Install Node.js 22.18.x–22.x or 24.11.0 and later, clone this repository,
   and set `name` in `wrangler.jsonc` to the Worker name you chose.

   ```sh
   git clone https://github.com/taxin-404/obsidian-livesync-cloudflare.git
   cd obsidian-livesync-cloudflare
   npm ci
   # edit "name" in wrangler.jsonc (replace live)
   ```

2. Copy the secret example and replace the password placeholder with a strong,
   unique password. `.dev.vars` is ignored by Git. A `wrangler.deploy.jsonc`
   copy is optional: `npm run deploy` reads `wrangler.jsonc` directly, while
   `npm run deploy:storage` reads the ignored copy.

   ```sh
   cp .dev.vars.example .dev.vars
   # edit .dev.vars
   # optional: cp wrangler.jsonc wrangler.deploy.jsonc
   ```

3. Sign in to the Cloudflare account where the Worker should run, then deploy
   the Worker and its secret together.

   ```sh
   npx wrangler login
   npm run deploy -- --secrets-file .dev.vars
   ```

   In this repository `npm run deploy` publishes the storage Worker from
   `wrangler.jsonc`, so the Worker name comes from the line you set in step 1;
   the optional `wrangler.deploy.jsonc` copy is only used by
   `npm run deploy:storage`.

Wrangler opens Cloudflare authentication in a browser. On success, it provisions
the SQLite Durable Object and applies its migration, uploads `COUCHDB_PASSWORD`
from `--secrets-file` as an encrypted Worker secret, and prints the deployed
`workers.dev` URL. When the account can use R2, it also creates the private
backup bucket and backup schedule; when it cannot, it deploys the same Worker
without backups.

You do not need to create a Cloudflare API token or copy an account ID, database
ID, or Durable Object ID.

## Deploy with the Cloudflare button

The button deploys **only the storage Worker**, its SQLite Durable Object,
private R2 backup bucket, and backup schedule. It does not deploy the MCP Worker.

[![Deploy sync server to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/taxin-404/obsidian-livesync-cloudflare)

On Cloudflare's setup page:

1. Choose the target account and repository name. Enable R2 on the account
   if using backups. For setup without R2 checkout, use the local deployment
   steps above with `BACKUP_ENABLED` set to `"false"`.
2. Keep the build root at the repository root and the build command blank.
   The prefill `npm run deploy` is correct: in this repository it publishes the
   storage Worker only, from `wrangler.jsonc`.
3. Review the prompted settings:

   | Setting | What to enter |
   | --- | --- |
   | Worker name | **Any name you like** (e.g. `live`, `my-vault-sync`); you enter it here |
   | `COUCHDB_PASSWORD` | A strong, unique password; save it for LiveSync |
   | `COUCHDB_USERNAME` | `admin`, or your preferred username |
   | `CORS_ORIGINS` | Keep the default for Obsidian desktop and mobile |
   | `BACKUP_DATABASE` | Your LiveSync database name; default `vault` |
   | `BACKUP_ENABLED` | `true` for daily backups; `false` to omit backup resources |
   | `BACKUP_DAILY`, `BACKUP_WEEKLY`, `BACKUP_MONTHLY` | Retention counts; defaults `30`, `8`, `24` |
   | `BACKUP_BUCKET` | A private backup bucket for this installation |

   The password prompt comes from the committed `.dev.vars.example`; non-secret
   settings come from `wrangler.jsonc`. `package.json` supplies the field
   descriptions. No local `.dev.vars` or `wrangler.deploy.jsonc` is needed for
   this browser setup. Never use the example password unchanged. The setup page
   writes the Worker name you enter into the new repository's `wrangler.jsonc`,
   so the dashboard Worker and the configuration agree.
4. Deploy, then enter the resulting Worker URL, database, username, and password
   in Obsidian LiveSync. Follow the README's recommended sync mode.

Cloudflare creates a copy of the repository and records resource configuration
there. For subsequent Workers Builds deployments, retain the storage-only command
above. If you later deploy locally, use that installation's updated
`wrangler.jsonc` (or copy it to `wrangler.deploy.jsonc` and use
`npm run deploy:storage`), preserving its Worker name and provisioned resources.

### Why there is no MCP deploy button

Cloudflare supports separate buttons for separate Workers, but a button targeting
a subdirectory copies only that subdirectory into the new repository. The MCP
workspace depends on the root lockfile, workspace installation, and
`packages/livesync-contracts`, so an `apps/cloudflare-obsidian-mcp` button would
produce an incomplete project.

MCP also needs an existing storage Worker in the same account, a matching
`POUCH_DATABASES.script_name` binding, and a GitHub OAuth app with the correct
callback and allowed user IDs. Use [the MCP setup](#deploy-the-mcp-worker) after
storage. A future MCP button would require a self-contained template plus those
external setup steps; it would not deploy both Workers automatically.

See Cloudflare's [button configuration and monorepo limitations](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## Configuration

- `COUCHDB_PASSWORD` is the only required secret. Choose a strong, unique value
  and do not commit it.
- `COUCHDB_USERNAME` is a non-secret variable and defaults to `admin`.
- `CORS_ORIGINS` is a non-secret variable. Its committed default supports
  Obsidian desktop, mobile, and local development.

To change the password after deployment, run:

```sh
npx wrangler secret put COUCHDB_PASSWORD --name <the Worker name you chose>
```

## Vault backups

`npm run deploy` checks whether R2 is available before deploying: it uses
backups when the account has R2, and omits the R2 binding and clears the cron
schedule when it does not. Pass `--require-r2` to stop rather than deploy
without backups, or `--no-r2` to always deploy without them. The check and its
output are described in
[docs/backup-recovery.md#deploy-without-r2](docs/backup-recovery.md#deploy-without-r2).

To force no backups with an ignored `wrangler.deploy.jsonc`, set
`vars.BACKUP_ENABLED` to the string `"false"` and use `npm run deploy:storage`.
For dev, set `env.dev.vars.BACKUP_ENABLED` and use `npm run deploy:storage:dev`.
The scripts omit the R2 binding and clear the cron schedule automatically;
no other settings need changing. Set it back to `"true"` and redeploy to
restore backup functionality. Existing R2 objects are not deleted.

For Workers Builds, `npm run deploy` is the deploy command that performs the
check; to force no backups there, use
`node scripts/deploy-storage.mjs wrangler.jsonc "" --no-r2` as the deploy
command.


Set `BACKUP_DATABASE` in the storage deployment configuration to the same database
name used in LiveSync (default `vault`). The deployment provisions a private R2
bucket and hourly scheduling check automatically. From 03:00 UTC it creates one
successful daily backup, retaining 30 daily, 8 weekly, and 24 monthly points.
R2 must be enabled on your account. See [backup and recovery](docs/backup-recovery.md)
for upgrades, operator commands, costs, and the LiveSync client reset procedure.

## Connect Obsidian LiveSync

Use these CouchDB settings after deployment:

- URI: the `workers.dev` URL printed by Wrangler, without a database suffix;
- database name: a lower-case CouchDB name such as `vault`;
- username: `admin`, unless you changed `COUCHDB_USERNAME`;
- password: the value you set for `COUCHDB_PASSWORD`.

Future deployments use `npm run deploy:storage`; the existing secret is
preserved without requiring a local secret file.

## Configuration files

Each Worker keeps a committed `wrangler.jsonc` for portable defaults and local
tests. `npm run deploy` reads the storage Worker's committed `wrangler.jsonc`
directly — set its `"name"` to the Worker name you chose. If you prefer a
separate per-account copy, create an ignored `wrangler.deploy.jsonc` in the same
directory and use `npm run deploy:storage`; the MCP deploy scripts use their
ignored copies too and fail if missing. Tests, type generation, and CI dry runs
use the committed templates.

Deployment files contain non-secret configuration: Worker names, public URLs,
vault names, GitHub Client IDs, allowlists, write settings, and provisioned
resource IDs. Keep passwords and client secrets in ignored `.dev.vars` files
or the existing Cloudflare secret store.

Back up deployment files separately: Git clones do not restore them. These are
full configuration copies, so carry shared code-entry, binding, migration, and
compatibility changes into the deployment copies when updating the templates.
The storage deployment script reads `BACKUP_ENABLED` from the selected
environment. When it is `"false"`, it passes Wrangler a temporary copy without
the backup R2 binding and with an empty cron schedule. It leaves the saved
configuration intact. Enabled deployments use the saved file directly.

For automated deployment with `npm run deploy`, the committed `wrangler.jsonc`
is the deployment file. Do not commit account-specific secrets merely to make a
Git-based build work; the ignored `wrangler.deploy.jsonc` copies are for local
`deploy:storage` and MCP deployments.

## Default and development deployments

The storage Worker ships with the name `live`; replace it with your own name if
you prefer. The MCP Worker is `obsidian-mcp`. Each configuration also defines an
optional `env.dev` (`live-dev` and `obsidian-mcp-dev`). One checkout supports
both.

| Command | Target |
| --- | --- |
| `npm run deploy` | Storage only, from `wrangler.jsonc` |
| `npm run deploy:storage` | Storage only, from `wrangler.deploy.jsonc` |
| `npm run deploy:no-r2` | Storage only, from `wrangler.jsonc`, without R2 |
| `npm run deploy:mcp` | MCP only, from `apps/cloudflare-obsidian-mcp/wrangler.deploy.jsonc` |
| `npm run deploy:dev` | Both dev Workers, storage first |
| `npm run deploy:storage:dev` | Dev storage only |
| `npm run deploy:mcp:dev` | Dev MCP only |

`deploy`, `deploy:no-r2`, and `deploy:storage:template` read the committed
`wrangler.jsonc`; the `deploy:storage*`, `deploy:mcp*`, and `deploy:dev` commands
use the ignored `wrangler.deploy.jsonc` copies. Default commands explicitly
select the top-level configuration (`--env ""`); dev commands select `--env dev`.
Configure default values at the top level and dev values under `env.dev`. Do not
pass `--env` to the aggregate npm scripts.

Wrangler does not inherit variables or resource bindings into named environments.
Keep the complete dev `vars`, Durable Object bindings, backup R2 binding, and OAuth KV
bindings in `env.dev`. Dev MCP must point at dev storage through
`POUCH_DATABASES.script_name`. Use separate KV namespaces for each
environment; retain provisioned IDs in the corresponding configuration.
Dev storage provisions its own private backup bucket. Set `BACKUP_DATABASE`
independently for each environment; do not point both environments at one bucket.

Configure each MCP environment's public URL, vault database, allowed user IDs,
and write setting. Register a separate GitHub OAuth app for dev, with its own
client ID, secret, and callback URL. Default MCP remains optional.

Before the first dev deployment, create any missing deployment copies using
`cp -n wrangler.jsonc wrangler.deploy.jsonc` and, if MCP is wanted,
`cp -n apps/cloudflare-obsidian-mcp/wrangler.jsonc apps/cloudflare-obsidian-mcp/wrangler.deploy.jsonc`.
For existing copies, carry the template's `env.dev` block into each copy and edit
its account-specific values. Do not overwrite existing deployment configuration.

Create ignored `.dev.vars.dev` files at each Worker
root from the corresponding `.dev.vars.example`, then run:

```sh
npm run deploy:storage:dev -- --secrets-file .dev.vars.dev
npm run deploy:mcp:dev -- --secrets-file apps/cloudflare-obsidian-mcp/.dev.vars.dev
```

These files are not uploaded automatically: `--secrets-file` installs their
secrets on the selected Worker. Later deployments preserve the installed secrets.
To update one interactively, include both the config and environment:

```sh
npx wrangler secret put COUCHDB_PASSWORD --config wrangler.deploy.jsonc --env dev
```

Existing deployments should retain their current Worker names, resource IDs,
URLs, and cross-Worker binding targets in `env.dev` if they are now your dev
installation. A new Worker name creates separate Durable Object storage; it does
not rename or copy the old vault. Set up the new default vault through LiveSync.
Do not overwrite existing deployment files by copying the templates again.

## Deploy the MCP Worker

**Upgrading to semantic contract 6:** add `MCP_PATH_RULES` to every MCP environment
in your existing ignored deployment copy before deploying. Set a JSON array of
folder rules or explicitly the JSON string `"[]"` for no folder restrictions
(MCP path validation still applies). Missing
or invalid configuration disables MCP and logs the variable name to Worker logs;
it does not affect Obsidian sync. `MCP_HIDE_DOT_FOLDERS="true"` is recommended for
new installations; its default is false. See [folder access policy](apps/cloudflare-obsidian-mcp/README.md#folder-access-policy)
for matching rules, read-only folders, privacy boundaries and local examples.

Deploy storage first with `npm run deploy`, then the MCP Worker with
`npm run deploy:mcp`.
A brief MCP incompatibility window is acceptable; standard Obsidian/CouchDB sync
remains unchanged. The derived search index rebuilds on first search after the
upgrade without modifying vault documents; retry while it catches up. Check a
visible note, a hidden note, a read-only note and an attachment after deployment,
and confirm Obsidian still syncs the restricted folders. Use disposable staging
notes for mutation checks. Roll back both Workers coherently or disable MCP until
they match; do not add unrestricted legacy RPC fallbacks.


The MCP Worker connects directly to the storage Worker's Durable Object. It
does not need the CouchDB URL or password. Before its first deployment:

1. Reuse the account subdomain from the existing storage Worker URL. The MCP
   origin is `https://obsidian-mcp.<account-subdomain>.workers.dev`.
   Register a GitHub OAuth app with this homepage and the same origin plus
   `/oauth/github/callback` as its callback URL.
2. Create the local deployment configuration:

   ```sh
   cp apps/cloudflare-obsidian-mcp/wrangler.jsonc apps/cloudflare-obsidian-mcp/wrangler.deploy.jsonc
   ```

   Set its non-secret `vars`: `GITHUB_CLIENT_ID`, `VAULT_DATABASE`,
   `MCP_PUBLIC_BASE_URL`, `GITHUB_ALLOWED_USER_IDS`, `MCP_WRITES_ENABLED`,
   `MCP_PATH_RULES`, and optionally `MCP_HIDE_DOT_FOLDERS`.
   Use `false` for an initial read-only test. If you rename the storage Worker,
   update this file's `POUCH_DATABASES` binding `script_name` to match.
3. Copy `apps/cloudflare-obsidian-mcp/.dev.vars.example` to
   `apps/cloudflare-obsidian-mcp/.dev.vars` and fill in only `GITHUB_CLIENT_SECRET`.
4. Deploy the Worker and secret together:

   ```sh
   npm run deploy:mcp -- --secrets-file apps/cloudflare-obsidian-mcp/.dev.vars
   ```

For a brand-new account, configure its workers.dev subdomain when deploying
storage first, then use that subdomain for MCP. An existing storage deployment
already supplies the suffix, so MCP needs no preliminary deployment.

Wrangler provisions OAuth KV on first deployment and reuses the existing
`OAUTH_KV` binding on subsequent deployments. Keep only `{ "binding": "OAUTH_KV" }`
in the committed template. Retain the namespace ID Wrangler provisions in the
ignored deployment file so subsequent deployments explicitly target that OAuth
store. For an existing deployment, copy its current ID rather than creating a
new namespace. The ID is non-secret but account-specific.

Generate types with `npm run types`; generation and checks use
`--strict-vars=false` to avoid literal URL, database, login, and client ID types.

After the initial deployments, use `npm run deploy:mcp` for MCP alone or
`npm run deploy` for both Workers in dependency order. Existing secrets are
preserved, so these commands do not require local secret files. Non-secret vars
come from the ignored deployment configurations; dashboard vars and `--keep-vars` are
unnecessary.

When migrating an existing deployment that stored `GITHUB_CLIENT_ID` as a
secret, set its public value in the ignored deployment file's `vars` and remove
`GITHUB_CLIENT_ID` from `secrets.required` in that file. Deploy them together.
Until the ID is available, omit it from `vars` and retain its existing required
secret binding; do not substitute a placeholder or delete the live secret first.

References: [workers.dev URLs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/),
[configuration best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
and [Wrangler type generation](https://developers.cloudflare.com/workers/wrangler/commands/workers/#types).

For upgrades, replace the old login allowlist with immutable account IDs; an
absent/invalid ID allowlist denies access, with no username fallback. Obtain and
verify IDs with `gh api user --jq '{login, id}'` and the GitHub users API. See
[contract 5 migration](apps/cloudflare-obsidian-mcp/README.md#upgrade-to-contract-5)
for token compatibility and configuration examples.

### SQLite schema-2 upgrade

Before deploying the `1.1.2-cloudflare-do.1` adapter, follow the
[pre-migration backup, rollout and recovery procedure](docs/backup-recovery.md#schema-2-rollout-and-recovery).
Do not run an older Worker against migrated storage. Current backup tools accept
only format 2; preserve the old application with its verified format-1 backup
for recovery to schema 1.
