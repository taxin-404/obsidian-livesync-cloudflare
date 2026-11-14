# Repository Guidelines

> **Asked whether upstream has a new release?** Read **Upstream updates** below
> first, then `docs/upstream-sync.md`. This repository is a snapshot, not a git
> fork: never `git merge upstream/main`, and report a verdict before porting.

## Project Structure & Module Organization

This npm workspace provides a CouchDB-compatible Cloudflare Worker backed by PouchDB in SQLite Durable Objects, plus an optional MCP Worker.

- `src/`: storage Worker, HTTP protocol, authentication, and Durable Object implementation; `livesync-vault/` handles logical vault operations, and `backup/` handles R2 backups.
- `apps/cloudflare-obsidian-mcp/`: MCP Worker source, OAuth integration, configuration, and tests.
- `packages/livesync-contracts/`: shared storage/MCP contracts.
- `test/`: storage integration tests, fixtures, and script tests.
- `scripts/`: backup, diagnostics, dependency checks, staging utilities, and `upstream-sync.mjs`.
- `docs/`, `COMPATIBILITY.md`, and `DEPLOY.md`: architecture constraints, operational procedures, and deployment guidance.

## Upstream updates

**Trigger:** the user says anything like "anything new upstream?", "the main repo
has an update", or asks whether an upstream change is worth taking. Follow this
section before answering, and before touching code.

This repository is a snapshot of
`https://github.com/robince/cloudflare-obsidian-livesync-mcp` at the commit in
`upstream.json` — not a git fork with shared history. **Never run
`git merge upstream/main`**; it merges unrelated trees.

1. Read `upstream.json` (repository, branch, pinned commit) and open that
   repository on GitHub to see the commits after the pin in their own context.
2. Run `npm run upstream:check`. It fetches the real repository and prints the
   commits and changed files since the pin, marking files this clone has also
   edited.
3. Read each commit's patch with `npm run upstream:diff -- <path>`. Do not judge
   from the subject line alone.
4. Decide with the rules below, then **report the verdict before porting**
   unless the user already said "port it".
5. Port with `npm run upstream:apply -- <path>` (clean files) or by hand (files
   marked *changed here too*). Never apply a patch you have not read.
6. Verify: `npm run check:storage`, the suites the change touches, and
   `npm run dry-run`. If deployed, confirm `/vault` responds and one Obsidian
   edit syncs.
7. Only then `npm run upstream:accept -- --yes`, and commit `upstream.json`
   with the ported files.

### Is it good for this clone?

| Upstream change | Verdict |
| --- | --- |
| Storage Worker protocol, revisions, sequence, compaction, auth, CORS | **Take** — this is the deployed surface. |
| Backup format, verification, restore, retention | **Take**, and run the backup suites. |
| Durable Object schema or a new `migrations` tag | **Take only with care** — copy the tag into `wrangler.jsonc` or existing data will not migrate. Explain the risk first. |
| Dependency or security update | **Usually take**; then `npm ci`, `npm run check:storage`, `npm test`, `npm run dry-run`. |
| MCP Worker (`apps/cloudflare-obsidian-mcp/`) | **Skip** unless a shared contract under `packages/livesync-contracts/` changed with it; only the storage Worker is deployed. |
| Staging, E2E, or MCP tooling (`scripts/staging/`, `test/live`, MCP OAuth test config) | **Skip** unless the user asks for it. |
| New Cloudflare binding, cron, queue, container, or paid feature | **Reject by default** — the account keeps this on the free tier with no free cron slots; alarms replace cron. Say what it would cost. |
| Upstream deploy scripts that assume a `CLOUDFLARE_API_TOKEN` | **Skip** — this clone deploys through Workers Builds. |
| README/docs describing upstream's own deployment | **Skip or adapt**; our docs describe `live`. |

Local differences to preserve when porting: the alarm backup patch in
`src/pouch-database.ts`, `wrangler.jsonc` (`name`, `crons: []`, R2 bucket,
`BACKUP_*`), `.github/workflows/ci.yml`, `.nvmrc`, `scripts/generate-setup-uri.sh`,
and the deployment docs. The client is Obsidian LiveSync 1.0.49 with E2EE on, so
protocol changes must stay compatible with it.

### Verdict format

Answer the user in this shape, and be explicit about what you would skip:

```
Upstream  <repo>  <pinned> -> <head>, N commits since the pin
Take      <commit / area> — why it matters here
Skip      <commit / area> — why it does not apply
Risk      migrations, protocol, free-tier cost, or none
Plan      files to port, tests to run, deploy step
```

Details, troubleshooting and the porting commands: `docs/upstream-sync.md`.

## Build, Test, and Development Commands

Use Node.js `^22.18.0 || >=24.11.0` and the root npm lockfile.

- `npm ci`: install workspace dependencies and apply the Commonlib patch automatically.
- `npx wrangler dev`: run the storage Worker locally; first copy `.dev.vars.example` to `.dev.vars` and configure credentials.
- `npm run types`: regenerate Worker binding declarations after configuration changes.
- `npm run types:check`: verify generated declarations are current.
- `npm run check`: check production dependencies and TypeScript across workspaces.
- `npm test`: run the primary storage and integration suites.
- `npm run test:all`: include workspace, staging-configuration, diagnostics, deploy and upstream-tool tests.
- `npm run upstream:check`: list upstream commits and files since the pin in `upstream.json`.
- `npm run dry-run`: bundle both Workers without deploying.

## Coding Style & Naming Conventions

Follow existing TypeScript: strict typing, ES modules, two-space indentation, single quotes, and semicolons. Use kebab-case filenames, camelCase functions and variables, and PascalCase types and classes. Keep shared RPC contracts in `packages/livesync-contracts`. No dedicated formatter or linter is configured; match surrounding code and run TypeScript checks.

## Testing Guidelines

Use Vitest with the Cloudflare plugin for workerd integration tests and Node's test runner for `.test.mjs` scripts. Name tests `*.test.ts` or `*.test.mjs` in the relevant `test/` directory. Add regression coverage for changed protocol, revision/conflict, authentication, and backup behavior. No numeric coverage threshold is configured. Before submitting, run the CI checks: `types:check`, `check`, `test:all`, and `dry-run`.

## Commit & Pull Request Guidelines

History generally uses short imperative subjects such as “Add single-vault R2 backups”; Conventional Commit prefixes appear occasionally but are not mandatory. Keep commits focused. PRs should explain the behavior change, relevant issues, validation performed, and configuration or compatibility implications. Update operational documentation when procedures change.

## Security & Configuration

Keep credentials in ignored `.dev.vars` files or Worker secrets. Never commit passwords or local `wrangler.deploy.jsonc` files. `npm run deploy` publishes the storage Worker from `wrangler.jsonc`; the MCP Worker is `deploy:mcp` and is not deployed here.
