# Credential rotation and drift detection — design

**Date:** 2026-11-13
**Status:** approved in conversation (A + C)

## Intent

Rotating the CouchDB password currently touches six places by hand: the Worker
secret, the setup-URI secret, the setup-passphrase secret, the local password
file, and two encrypted fields inside the Obsidian vault. Nothing enforces that
they move together, so a single edit in the Cloudflare dashboard silently broke
the phone, the setup page and the desktop vault at once (2026-11-13, 14:36 UTC).

Rotation should be one command that moves every dependent secret together and
proves the result, and a second command that says which link has drifted when
something is off.

## What exists today

- `src/landing.ts` serves the setup page from `SETUP_URI` + `SETUP_URI_PASSPHRASE`,
  gated by `PAGE_PASSWORD || COUCHDB_PASSWORD`. Without the URI secrets it falls
  back to showing URL, database, username and password.
- `scripts/generate-setup-uri.sh` calls the upstream deno generator, which builds
  a **fresh-vault** settings object (`createNewVaultSettings()` +
  `PREFERRED_SETTING_SELF_HOSTED`) and emits a persistent setup URI.
- The plugin (1.0.50) stores the live connection only in
  `remoteConfigurations[active].uri`, encrypted with the config key
  `"*" + "rHGMPtr6oWw7VSa3W3wpa8fT8U"` when `configPassphraseStore` is empty.
  `encryptedCouchDBConnection` is legacy and currently stale (8-character
  password, from before the last rotation).
- Envelope format, verified against the real vault:
  `"%$" + base64(pbkdf2Salt32 || iv12 || hkdfSalt32 || AES-GCM(ciphertext+tag))`,
  key = PBKDF2-SHA256(password, pbkdf2Salt, 310000) → HKDF(salt = hkdfSalt,
  info = empty) → AES-GCM-256.

### The bug this found

The setup URI currently deployed carries an **ID derivation key that differs
from the vault's**. A new device that imports that URI would derive different
file identities from the same paths and duplicate the vault. The E2EE
passphrase does match. This is exactly what `check:secrets` must catch.

## Goals

1. `npm run rotate:password -- --vault <path>` regenerates the password and
   every secret derived from it, verifies the result end to end, and prints the
   steps for the remaining devices.
2. `npm run check:secrets -- --vault <path>` compares the live deployment with
   the local vault and names the mismatched piece; exit 1 on drift.
3. Neither command ever prints a secret except where the gated page would.
4. Failed verification never leaves a half-rotated state silently.

## Non-goals

- A grace period where the old password keeps working (rejected in conversation:
  paired devices re-pair).
- Updating phones or other remote devices automatically — a phone holds its own
  credentials and the server cannot reach it.
- Any new server endpoint, secret, cron, or Cloudflare resource.
- Replacing the upstream deno generator for first-time setup.

## Anti-goals

- A tool that "works" by silently changing device-level settings. The setup URI
  a phone consumes must stay a new-device profile: no `additionalSuffixOfDatabaseName`,
  no `syncInternalFiles` patterns, no desktop identity.
- Burying rotation inside deploy scripts.
- Diverging from the plugin's wire format. Anything we cannot express exactly is
  a failure, not a guess.

## Approaches considered

1. **Drive Obsidian over CDP** and call the plugin's own encrypt/encode helpers.
   No format reimplementation, but requires a GUI session, a debug port, a
   running app, and breaks the "Obsidian must be closed while writing" rule.
2. **Reimplement the two formats offline (chosen).** Node's WebCrypto reproduces
   the envelope exactly; verified against the real vault before writing anything.
   Fast, testable in CI, no GUI. Compatibility is proven at runtime by decrypting
   the live blobs on every run and failing loudly on an unknown prefix.
3. **Drop the setup URI, show raw credentials** (the landing page fallback).
   Simplest, but loses one-tap onboarding and the E2EE passphrase hand-off that
   makes a phone usable, and does not satisfy the request.

Chosen: 2, with 1's safety property (never write what we cannot decrypt) enforced
by preflight and post-write verification.

## Decisions

### Rotation is template-driven

The setup URI a phone consumes is not the desktop vault's settings — it is the
new-device profile the current page already serves. Rotation therefore:

1. reads the live page with the **current** password,
2. decrypts its setup URI with the passphrase shown on that page,
3. keeps that profile, and replaces only the authoritative facts:
   `couchDB_PASSWORD` (new), `couchDB_URI/USER/DBNAME` and the single plaintext
   `remoteConfigurations` entry (from the vault's active config),
   `passphrase` and `idDerivationKey`/`idDerivationVersion` (from the vault, so a
   new device derives the same file identities), blanks `encrypted*` fields, and
   drops P2P runtime keys,
4. re-encrypts with a fresh 32-character setup passphrase.

If the page cannot be read or decrypted, rotation refuses before changing
anything. That is deliberate: the profile is not reproducible from the vault
alone.

### Order of operations

Everything is built and self-checked in memory first, then:

1. `COUCHDB_PASSWORD` → 2. `SETUP_URI` → 3. `SETUP_URI_PASSPHRASE` →
4. password file (0600, atomic) → 5. vault `data.json` (atomic, 2-space, trailing
newline, otherwise byte-identical round trip) → 6. verify.

Verification: old password 401, new password 200 on `/vault`, gate accepts the new
password and serves the exact URI we pushed, the served URI decrypts to the new
password, the vault's decrypted `remoteConfigurations[active].uri` carries the new
password, `encryptedCouchDBConnection` carries it too.

A failure at step 3 or later prints the exact re-run command; the password file is
written only after all three secrets are accepted, so a crashed run never leaves
the local file pointing at a password the server does not accept.

### Refusals

- Obsidian running (`pgrep -f app.asar`) → refuse unless `--force`; it rewrites
  `data.json` from memory and would undo the change.
- Vault missing, plugin data missing, unknown blob prefix, or a decrypted value
  that is not the expected shape → refuse with the reason.
- `--dry-run` performs every read and build, prints a redacted summary, and
  changes nothing.

### Check semantics

`check:secrets` reports one line per link and exits non-zero if any fails:

| Link | Test |
| --- | --- |
| Server accepts saved password | `GET /vault` with Basic auth → 200 |
| Gate accepts it | `POST /` with the password, `accept: text/html` → 200 and a setup URI |
| Page is not stale | URI decrypts with the page passphrase; `couchDB_PASSWORD` equals the saved password |
| New devices will be compatible | URI `passphrase` and `idDerivationKey` equal the vault's |
| Vault agrees | `remoteConfigurations[active].uri` and `encryptedCouchDBConnection` carry the saved password |

Host, database and username are compared too. Nothing secret is printed; only
which link failed and the one-line fix.

## Files

- `scripts/livesync-config.mjs` — key derivation, `%$` envelope, settings
  read/write, remote-URI and legacy-connection helpers, setup-URI encode/decode.
- `scripts/rotate-password.mjs` — preflight, in-memory build, secret push,
  writes, verification, phone instructions.
- `scripts/check-secrets.mjs` — the five comparisons.
- `test/livesync-config.test.mjs`, `test/rotate-password.test.mjs`,
  `test/check-secrets.test.mjs` — node:test, no network, no wrangler.
- `package.json` — `rotate:password`, `check:secrets`, `test:secrets` (added to
  `test` so CI covers it).
- `README.md`, `docs/auto-deploy.md` — replace the manual rotation instructions.

## Constraints

- Node `^22.18.0 || >=24.11.0`, ESM, no new dependencies, WebCrypto only.
- Two-space indentation, single quotes, semicolons, kebab-case files.
- Free tier only: no new secrets beyond the three existing ones, no cron.
- Plugin 1.0.50 remains the client.

## Left to the builder

Test layout inside the files above, wording of the refusal and success messages,
and the exact `node --test` invocation wiring in `package.json`.
