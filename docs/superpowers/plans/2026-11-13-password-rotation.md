# Credential Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command rotates the CouchDB password together with every secret derived from it, and a second command names the link that has drifted.

**Architecture:** Offline WebCrypto reproduces the plugin's `%$` envelope and the setup-URI blob. Rotation reads the live setup page as the new-device profile, merges the vault's authoritative facts (E2EE passphrase, ID derivation key, remote host), pushes three Worker secrets, then rewrites the password file and the vault's `data.json`, verifying the result over HTTP.

**Tech Stack:** Node 22/24 ESM, `node:crypto` WebCrypto, `node:test`, `npx wrangler` for secret writes, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-password-rotation-design.md`

## Global Constraints

- Node `^22.18.0 || >=24.11.0`; ESM only; no new dependencies; WebCrypto only.
- Style: two-space indent, single quotes, semicolons, kebab-case files.
- Config key when `configPassphraseStore` is empty: `*` + `rHGMPtr6oWw7VSa3W3wpa8fT8U`.
- Envelope: `%$` + base64(`pbkdf2Salt(32) || iv(12) || hkdfSalt(32) || AES-GCM(ct||tag)`), PBKDF2-SHA256 310000 iterations, HKDF-SHA256 with empty info, AES-GCM-256, 128-bit tag.
- `data.json` must round-trip byte-identically: `JSON.stringify(value, null, 2) + '\n'`.
- Never print a secret. Redact every value that is a password, passphrase, key, or URI.
- No new Worker secrets, bindings, crons, or endpoints.
- Tests must run offline; no wrangler, no network, no real vault.

## Review Focus

- **`data.json` churn**: a rewrite that reorders keys, changes indentation, or drops the trailing newline makes Obsidian show a settings change and can race the plugin. Round trip must be byte-identical.
- **Secret leakage**: any log line, error message, or JSON dump that prints the password, E2EE passphrase, ID key, or setup URI. Assert redaction in tests.
- **Half-rotated state**: the password file or `data.json` written before all three secrets are accepted leaves devices unable to authenticate with no way back. Test the ordering.
- **Wrong device profile**: a setup URI that omits the vault's `idDerivationKey` or E2EE passphrase makes a new device derive different file identities and duplicate the vault. Test both.
- **Unknown blob prefix**: a future plugin format must abort before any write, naming the prefix it found.
- **Non-ASCII and special characters** in the vault path, host, or password must survive parse/format/encrypt unchanged.
- **Obsidian running**: writing `data.json` under a live plugin is undone from memory. Test the refusal and `--force`.

---

### Task 1: Envelope crypto

**Files:**
- Create: `scripts/livesync-config.mjs`
- Test: `test/livesync-config.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CONFIG_SALT`, `DEFAULT_CONFIG_PASSPHRASE`, `ENCRYPTED_PREFIX`, `PBKDF2_ITERATIONS`
  - `configPassphrase(settings: object): string`
  - `isEncryptedBlob(value: unknown): boolean`
  - `encryptValue(plaintext: string, passphrase: string, options?: { random?: (bytes: number) => Uint8Array }): Promise<string>`
  - `decryptValue(blob: string, passphrase: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

```js
// test/livesync-config.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configPassphrase, decryptValue, encryptValue, isEncryptedBlob, DEFAULT_CONFIG_PASSPHRASE } from '../scripts/livesync-config.mjs';

test('round-trips unicode plaintext', async () => {
  const secret = 'বাংলা notes — {"a":1} 🔐';
  const blob = await encryptValue(secret, 'pass-1');
  assert.ok(blob.startsWith('%$'));
  assert.equal(await decryptValue(blob, 'pass-1'), secret);
});

test('fails a different passphrase', async () => {
  const blob = await encryptValue('payload', 'right');
  await assert.rejects(() => decryptValue(blob, 'wrong'));
});

test('pins the envelope layout with a fixed random source', async () => {
  const random = (bytes) => new Uint8Array(bytes).fill(7);
  const blob = await encryptValue('fixed', 'fixed-pass', { random });
  assert.equal(blob.slice(0, 2), '%$');
  assert.equal(Buffer.from(blob.slice(2), 'base64').length, 32 + 12 + 32 + Buffer.byteLength('fixed') + 16);
  assert.equal(await decryptValue(blob, 'fixed-pass'), 'fixed');
});

test('rejects unknown prefixes without touching crypto', async () => {
  assert.equal(isEncryptedBlob('%$abc'), true);
  assert.equal(isEncryptedBlob('%abc'), false);
  assert.equal(isEncryptedBlob('{"plain":true}'), false);
  await assert.rejects(() => decryptValue('%v2-old', 'pass'), /unsupported encrypted value prefix/);
});

test('uses the stored config passphrase when present', () => {
  assert.equal(configPassphrase({ configPassphraseStore: '' }), DEFAULT_CONFIG_PASSPHRASE);
  assert.equal(configPassphrase({ configPassphraseStore: 'chosen' }), 'chosen');
});

test('round-trips through the real fixed salt', async () => {
  const blob = await encryptValue('x', DEFAULT_CONFIG_PASSPHRASE);
  assert.equal(await decryptValue(blob, DEFAULT_CONFIG_PASSPHRASE), 'x');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/livesync-config.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/livesync-config.mjs'`.

- [ ] **Step 3: Implement the module**

Implement exactly the constants and four functions above using `node:crypto`'s `webcrypto`. `encryptValue` draws 32 bytes for the PBKDF2 salt, 12 for the IV, 32 for the HKDF salt from `options.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)))`, and concatenates them in that order before base64. `decryptValue` throws `new Error(\`unsupported encrypted value prefix: ${blob.slice(0, 2)}\`)` when the prefix is not `%$`, and rejects input shorter than 76 bytes with `invalid encrypted value length`. Derive the AES key exactly as the spec describes: PBKDF2(password bytes) → export raw → import as HKDF → HKDF(salt=hkdfSalt, info=empty).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/livesync-config.test.mjs`
Expected: `pass 6`.

- [ ] **Step 5: Prove it against the real vault (read only)**

Run:

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { decryptValue, DEFAULT_CONFIG_PASSPHRASE } from './scripts/livesync-config.mjs';
const d = JSON.parse(readFileSync(process.env.HOME + '/Documents/notes/.obsidian/plugins/obsidian-livesync/data.json','utf8'));
const uri = await decryptValue(d.remoteConfigurations[d.activeConfigurationId].uri, DEFAULT_CONFIG_PASSPHRASE);
console.log(uri.replace(/:[^:@/]*@/, ':***@'));
"
```

Expected: one line `sls+https://admin:***@live.obsidian-sync.workers.dev/?db=vault`. Anything else means the envelope is wrong; stop and fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add scripts/livesync-config.mjs test/livesync-config.test.mjs
git commit -m "Add LiveSync envelope crypto for credential tooling"
```

---

### Task 2: Vault reading and remote URI editing

**Files:**
- Modify: `scripts/livesync-config.mjs`
- Test: `test/livesync-config.test.mjs`

**Interfaces:**
- Consumes: `decryptValue`, `isEncryptedBlob`, `configPassphrase` from Task 1.
- Produces:
  - `readVault(vaultDir: string): Promise<VaultState>` where
    `VaultState = { dataPath: string, data: object, e2eePassphrase: string, idDerivationKey: string, idDerivationVersion: number, activeRemoteId: string, remoteUri: string, remote: RemoteParts, legacyConnection: object }`
  - `RemoteParts = { user: string, password: string, host: string, pathname: string, search: string }`
  - `parseRemote(uri: string): RemoteParts`
  - `formatRemote(parts: RemoteParts): string`
  - `writeVault(vaultDir: string, data: object): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```js
test('parses and reformats a sls+ remote uri, keeping path and query', () => {
  const parts = parseRemote('sls+https://admin:p%40ss@example.workers.dev/?db=vault');
  assert.equal(parts.user, 'admin');
  assert.equal(parts.host, 'example.workers.dev');
  assert.equal(parts.search, '?db=vault');
  assert.equal(formatRemote({ ...parts, password: 'next' }), 'sls+https://admin:next@example.workers.dev/?db=vault');
});

test('keeps a password with special characters intact', () => {
  const parts = parseRemote('sls+https://admin:old@host.test/?db=vault');
  const uri = formatRemote({ ...parts, password: 'a/b+c=d' });
  assert.equal(parseRemote(uri).password, 'a/b+c=d');
});

test('round-trips data.json byte for byte', async () => {
  const dir = await makeVault();               // helper writes a fixture vault, returns its path
  const original = await readFile(path.join(dir, '.obsidian/plugins/obsidian-livesync/data.json'), 'utf8');
  await writeVault(dir, (await readVault(dir)).data);
  assert.equal(await readFile(path.join(dir, '.obsidian/plugins/obsidian-livesync/data.json'), 'utf8'), original);
});

test('refuses a vault whose encrypted value has an unknown prefix', async () => {
  const dir = await makeVault({ remoteUri: '%v2-unknown' });
  await assert.rejects(() => readVault(dir), /unsupported encrypted value prefix/);
});
```

`makeVault(options)` is a test helper in the same file: create a temp dir with `.obsidian/plugins/obsidian-livesync/data.json`, fill it with `encryptValue` results for `encryptedPassphrase` (`'f'.repeat(64)`), `encryptedIdDerivationKey` (`'a'.repeat(64)`), `encryptedCouchDBConnection` (JSON with the 14 legacy keys and password `'old'`), and one `remoteConfigurations` entry whose `uri` is `sls+https://admin:old@host.test/?db=vault` encrypted with `DEFAULT_CONFIG_PASSPHRASE`; plus `configPassphraseStore: ''`, `activeConfigurationId: 'remote-test'`, `idDerivationVersion: 1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/livesync-config.test.mjs`
Expected: FAIL — `parseRemote is not a function`.

- [ ] **Step 3: Implement**

`readVault` reads the JSON, derives the config key with `configPassphrase`, decrypts the three blobs plus the active remote URI, and throws `no active remote configuration` when `activeConfigurationId` is missing from `remoteConfigurations`. `parseRemote` strips the `sls+` prefix, parses with `new URL`, and decodes `decodeURIComponent` for user and password. `formatRemote` re-encodes user and password with `encodeURIComponent` and rebuilds `${'sls+'}https://${user}:${password}@${host}${pathname}${search}`. `writeVault` writes `JSON.stringify(data, null, 2) + '\n'` to `data.json.tmp` (mode 0600) and renames it over the original.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/livesync-config.test.mjs`
Expected: `pass 10`.

- [ ] **Step 5: Commit**

```bash
git add scripts/livesync-config.mjs test/livesync-config.test.mjs
git commit -m "Read and rewrite the vault connection without touching other settings"
```

---

### Task 3: Setup URI encode and decode

**Files:**
- Modify: `scripts/livesync-config.mjs`
- Test: `test/livesync-config.test.mjs`

**Interfaces:**
- Consumes: `encryptValue`, `decryptValue`.
- Produces:
  - `SETUP_URI_PREFIX = 'obsidian://setuplivesync?settings='`
  - `encodeSetupUri(settings: object, setupPassphrase: string): Promise<string>`
  - `decodeSetupUri(uri: string, setupPassphrase: string): Promise<object>`
  - `buildProfile({ profile, remote, password, e2eePassphrase, idDerivationKey, idDerivationVersion, setupPassphrase }): { settings: object, uri: string }`

- [ ] **Step 1: Write the failing tests**

```js
test('encodes and decodes a setup uri', async () => {
  const settings = { couchDB_PASSWORD: 'p@ss', remoteConfigurations: { 'remote-x': { id: 'remote-x', name: 'n', uri: 'sls+https://admin:p@ss@h/?db=vault', isEncrypted: false } } };
  const uri = await encodeSetupUri(settings, 'uri-pass');
  assert.ok(uri.startsWith('obsidian://setuplivesync?settings='));
  assert.deepEqual(await decodeSetupUri(uri, 'uri-pass'), settings);
});

test('buildProfile keeps the device profile and swaps only the authoritative facts', async () => {
  const profile = {
    couchDB_URI: 'https://old.example', couchDB_USER: 'admin', couchDB_PASSWORD: 'old', couchDB_DBNAME: 'vault',
    encrypt: true, usePathObfuscation: true, encryptInternalMetadata: true,
    passphrase: 'stale', idDerivationVersion: 1, idDerivationKey: 'stale',
    configPassphraseStore: '', encryptedPassphrase: '', encryptedCouchDBConnection: '',
    pluginSyncExtendedSetting: {}, P2P_managedType: 'x',
    remoteConfigurations: { 'remote-old': { id: 'remote-old', name: 'old', uri: 'sls+https://admin:old@old.example/?db=vault', isEncrypted: true } },
  };
  const built = buildProfile({
    profile,
    remote: { user: 'admin', password: 'new', host: 'live.example', pathname: '/', search: '?db=vault' },
    password: 'new',
    e2eePassphrase: 'e'.repeat(64),
    idDerivationKey: 'k'.repeat(64),
    idDerivationVersion: 1,
    setupPassphrase: 'uri-pass',
  });
  const settings = built.settings;
  assert.equal(settings.couchDB_PASSWORD, 'new');
  assert.equal(settings.couchDB_URI, 'https://live.example');
  assert.equal(settings.passphrase, 'e'.repeat(64));
  assert.equal(settings.idDerivationKey, 'k'.repeat(64));
  assert.equal(settings.configPassphraseStore, '');
  assert.equal(settings.encryptedCouchDBConnection, '');
  assert.equal(settings.encryptedPassphrase, '');
  assert.equal('P2P_managedType' in settings, false);
  assert.equal(Object.keys(settings.remoteConfigurations).length, 1);
  const [remote] = Object.values(settings.remoteConfigurations);
  assert.equal(remote.isEncrypted, false);
  assert.equal(remote.uri, 'sls+https://admin:new@live.example/?db=vault');
  assert.deepEqual(await decodeSetupUri(built.uri, 'uri-pass'), settings);
});

test('buildProfile does not add desktop-only keys', () => {
  const built = buildProfile({ profile: { remoteConfigurations: {} }, remote: { user: 'admin', password: 'n', host: 'h', pathname: '/', search: '' }, password: 'n', e2eePassphrase: 'e', idDerivationKey: 'k', idDerivationVersion: 1, setupPassphrase: 'p' });
  for (const key of ['additionalSuffixOfDatabaseName', 'syncInternalFiles', 'syncInternalFilesTargetPatterns', 'deviceAndVaultName', 'pluginSyncExtendedSetting']) {
    assert.equal(key in built.settings, false, key);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/livesync-config.test.mjs`
Expected: FAIL — `encodeSetupUri is not a function`.

- [ ] **Step 3: Implement**

`encodeSetupUri` encrypts `JSON.stringify(settings)` with the setup passphrase and returns `SETUP_URI_PREFIX + encodeURIComponent(blob)`. `decodeSetupUri` strips the prefix, `decodeURIComponent`, decrypts, parses, and throws `not a setup URI` when the prefix is absent. `buildProfile` deep-copies the profile, deletes `P2P_managedType`, `P2P_managedId`, `P2P_managedToken`, `pluginSyncExtendedSetting`, sets `passphrase`, `idDerivationKey`, `idDerivationVersion`, `couchDB_PASSWORD`, `couchDB_USER`, `couchDB_DBNAME`, `couchDB_URI` (scheme `https://` + host, no trailing slash), blanks `configPassphraseStore`, `encryptedPassphrase`, `encryptedCouchDBConnection`, and replaces `remoteConfigurations` with a single fresh entry `{ id, name, uri: formatRemote(remote), isEncrypted: false }` where `id` is `remote-<8 hex>-<6 hex>` from WebCrypto random bytes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/livesync-config.test.mjs`
Expected: `pass 13`.

- [ ] **Step 5: Commit**

```bash
git add scripts/livesync-config.mjs test/livesync-config.test.mjs
git commit -m "Build new-device setup URIs from the live profile"
```

---

### Task 4: Rotation orchestration

**Files:**
- Create: `scripts/rotate-password.mjs`
- Test: `test/rotate-password.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `generatePassword(random?): string` — 28 characters from `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`
  - `generateSetupPassphrase(random?): string` — base64url of 24 bytes, 32 characters, no padding
  - `rotate({ vaultDir, passwordFile, worker, accountId, putSecret, fetchPage, fetchAuth, obsidianRunning, now, random, dryRun, force }): Promise<{ password, setupUri, setupPassphrase, steps: string[] }>`
    (`obsidianRunning`, `putSecret`, `fetchPage`, `fetchAuth` and `random` are injectable; the CLI supplies the real ones in Task 6.)

- [ ] **Step 1: Write the failing tests**

```js
test('generates a 28 character alphanumeric password', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) { const p = generatePassword(); assert.match(p, /^[A-Za-z0-9]{28}$/); seen.add(p); }
  assert.equal(seen.size, 500);
});

test('rotates every secret and verifies before writing local state', async () => {
  const calls = [];
  const vault = fixture();
  const result = await rotate({
    ...vault,
    putSecret: async (name, value) => calls.push(['secret', name, value]),
    fetchPage: async () => pageHtml(await encodeSetupUri(profileFor({ password: 'old', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'a'.repeat(64) }), 'old-uri-pass')),
    fetchAuth: async (password) => password === 'old' ? 401 : 200,
  });
  // order: password, uri, passphrase, then local writes
  assert.deepEqual(calls.slice(0, 3).map(([, name]) => name), ['COUCHDB_PASSWORD', 'SETUP_URI', 'SETUP_URI_PASSPHRASE']);
  assert.equal(calls[1][2], result.setupUri);
  const after = await readVault(vault.vaultDir);
  assert.equal(parseRemote(await decryptValue(after.remoteUri, DEFAULT_CONFIG_PASSPHRASE)).password, result.password);
  assert.equal((await readFile(vault.passwordFile, 'utf8')).trim(), result.password);
});

test('leaves the vault and password file untouched when a secret push fails', async () => {
  const before = await snapshot(fixture());
  await assert.rejects(() => rotate({ ...fixture(), putSecret: async (name) => { if (name === 'SETUP_URI') throw new Error('boom'); }, fetchPage: async () => pageHtml(await encodeSetupUri(profileFor({ password: 'old', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'a'.repeat(64) }), 'old-uri-pass')), fetchAuth: async () => 200 }));
  assert.deepEqual(await snapshot(fixture()), before);
});

test('refuses while Obsidian is running unless forced', async () => {
  await assert.rejects(() => rotate({ ...fixture(), obsidianRunning: () => true }), /Obsidian is running/);
});

test('dry run changes nothing', async () => {
  const before = await snapshot(fixture());
  const result = await rotate({ ...fixture(), dryRun: true, fetchPage: async () => pageHtml(await encodeSetupUri(profileFor({ password: 'old', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'a'.repeat(64) }), 'old-uri-pass')), fetchAuth: async () => 200 });
  assert.deepEqual(await snapshot(fixture()), before);
  assert.ok(result.steps.length > 0);
});

test('never prints a secret in the returned steps', async () => {
  const result = await rotate({ ...fixture(), fetchPage: async () => pageHtml(await encodeSetupUri(profileFor({ password: 'old', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'a'.repeat(64) }), 'old-uri-pass')), fetchAuth: async () => 200, putSecret: async () => {}, obsidianRunning: () => false, dryRun: true });
  const text = result.steps.join('\n');
  assert.equal(text.includes(result.password), false);
  assert.equal(text.includes(result.setupPassphrase), false);
});
```

`fixture()` returns `{ vaultDir, passwordFile, worker: 'live', accountId: 'test', obsidianRunning: () => false, random: fixedRandom() }` built with the same `makeVault` helper as Task 2, plus a password file containing `old`. `profileFor({ password, e2eePassphrase, idDerivationKey })` returns the new-device profile used by both this file and Task 5. `pageHtml(uri)` renders `<dd id="v-uri">…</dd><dd id="v-pass">old-uri-pass</dd>` with HTML escaping.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/rotate-password.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/rotate-password.mjs'`.

- [ ] **Step 3: Implement `rotate`**

Order inside `rotate`:

1. `readVault`, using the password file's value as the current password; decrypt and assert the active remote's password matches it, else throw `vault password and password file disagree — run check:secrets`.
2. Refuse when `obsidianRunning()` unless `force`; refuse when `dryRun` and not `force` does nothing else special.
3. `fetchPage(currentPassword)` → parse `v-uri` and `v-pass` → `decodeSetupUri`.
4. Build `password`, `setupPassphrase`, `buildProfile(...)`.
5. Self-check: `decodeSetupUri(newUri, setupPassphrase)` equals the built settings.
6. If `dryRun`, return redacted steps and stop.
7. `putSecret('COUCHDB_PASSWORD', password)`, then `SETUP_URI`, then `SETUP_URI_PASSPHRASE`.
8. `fetchAuth` with the new password must be 200 and with the old must be 401; the gate page fetched with the new password must contain exactly `result.setupUri`.
9. Write the password file (0600, temp + rename), then `writeVault` with re-encrypted `encryptedPassphrase`, `encryptedIdDerivationKey`, `encryptedCouchDBConnection` (legacy object with the new password), and `remoteConfigurations[active].uri` = `formatRemote({ ...remote, password })`, `isEncrypted: true`.
10. Re-read the vault and assert the two fields decrypt to the new password.
11. Return `{ password, setupUri, setupPassphrase, steps }` where `steps` names the phone action, the desktop restart, and the fact that other devices must re-pair.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/rotate-password.test.mjs`
Expected: `pass 6`.

- [ ] **Step 5: Commit**

```bash
git add scripts/rotate-password.mjs test/rotate-password.test.mjs
git commit -m "Rotate the password and every derived secret in one run"
```

---

### Task 5: Drift check

**Files:**
- Create: `scripts/check-secrets.mjs`
- Test: `test/check-secrets.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `checkSecrets({ vaultDir, passwordFile, fetchPage, fetchAuth }): Promise<{ ok: boolean, links: Array<{ name: string, ok: boolean, detail: string }>, exitCode: 0 | 1 }>`

- [ ] **Step 1: Write the failing tests**

```js
// test/check-secrets.test.mjs — uses the same fixture helpers as Task 4
const good = () => profileFor({ password: 'old', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'a'.repeat(64) });
const page = async (profile) => pageHtml(await encodeSetupUri(profile, 'uri-pass'));

test('reports every link green when the deployment is consistent', async () => {
  const report = await checkSecrets({ ...fixture(), fetchAuth: async () => 200, fetchPage: async () => page(good()) });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.deepEqual(report.links.map((l) => l.name), ['server password', 'setup page gate', 'setup URI password', 'setup URI device profile', 'vault connection']);
});

test('names the stale setup URI', async () => {
  const report = await checkSecrets({ ...fixture(), fetchAuth: async () => 200, fetchPage: async () => page(profileFor({ password: 'older', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'a'.repeat(64) })) });
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.links.filter((l) => !l.ok).map((l) => l.name), ['setup URI password']);
});

test('names a mismatched ID derivation key', async () => {
  const report = await checkSecrets({ ...fixture(), fetchAuth: async () => 200, fetchPage: async () => page(profileFor({ password: 'old', e2eePassphrase: 'e'.repeat(64), idDerivationKey: 'b'.repeat(64) })) });
  assert.deepEqual(report.links.filter((l) => !l.ok).map((l) => l.name), ['setup URI device profile']);
});

test('names a rejected server password and an unreachable page', async () => {
  const report = await checkSecrets({ ...fixture(), fetchAuth: async () => 401, fetchPage: async () => '<html>sign in</html>' });
  assert.deepEqual(report.links.filter((l) => !l.ok).map((l) => l.name), ['server password', 'setup page gate', 'setup URI password', 'setup URI device profile']);
});

test('never prints secrets', async () => {
  const vault = fixture();
  const report = await checkSecrets({ ...vault, fetchAuth: async () => 401, fetchPage: async () => page(good()) });
  const text = JSON.stringify(report);
  assert.equal(text.includes((await readFile(vault.passwordFile, 'utf8')).trim()), false);
  assert.equal(text.includes('e'.repeat(64)), false);
});
```

`profileFor({ password, e2eePassphrase, idDerivationKey })` builds the new-device profile: `couchDB_URI/USER/DBNAME` matching the fixture, one plaintext `remoteConfigurations` entry carrying `password`, `passphrase` and `idDerivationKey`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/check-secrets.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the five links**

Names, in order: `server password`, `setup page gate`, `setup URI password`, `setup URI device profile`, `vault connection`. Each `detail` is one sentence naming what was expected and what was found, with no secret values. `exitCode` is 1 when any link fails. A page that cannot be parsed yields `setup page gate: fail` with detail `the page did not return a setup URI`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/check-secrets.test.mjs`
Expected: `pass 5`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-secrets.mjs test/check-secrets.test.mjs
git commit -m "Name the credential link that has drifted"
```

---

### Task 6: CLI wiring and documentation

**Files:**
- Modify: `package.json`, `README.md` (Connection details page, Operations), `docs/auto-deploy.md` (Rotate the password)
- Test: `test/rotate-password.test.mjs` (argument parsing)

**Interfaces:**
- Consumes: `rotate`, `checkSecrets`.
- Produces: `npm run rotate:password -- --vault <path> [--worker live] [--dry-run] [--force] [--json]` and `npm run check:secrets -- --vault <path> [--json]`; `parseArgs(argv)` exported from both scripts for tests.

- [ ] **Step 1: Write the failing tests**

```js
test('parses the rotation arguments', () => {
  assert.deepEqual(parseArgs(['--vault', '/v', '--worker', 'live', '--dry-run']), { vault: '/v', worker: 'live', dryRun: true, force: false, json: false });
});

test('rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument: --nope/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/rotate-password.test.mjs`
Expected: FAIL — `parseArgs is not a function`.

- [ ] **Step 3: Implement the executable entry points**

At the bottom of each script, `if (import.meta.url === pathToFileURL(process.argv[1]).href) main();`. `main` resolves defaults (`--vault` required; `--worker` defaults to `process.env.LIVESYNC_WORKER ?? 'live'`; password file defaults to `${HOME}/.config/obsidian-livesync/server-password`), wires the real adapters (`putSecret` runs `npx wrangler secret put <NAME> --name <worker>` with the value on stdin and `CLOUDFLARE_ACCOUNT_ID` from the environment; `fetchPage` posts `password=<encoded>` with `accept: text/html` to the remote origin; `fetchAuth` does `GET /vault` with Basic auth), prints the green/red table for `check:secrets` and the steps for `rotate`, and exits with the returned code. `--json` prints the report object instead of the table, still redacted.

- [ ] **Step 4: Wire the scripts**

Add to `package.json`: `"rotate:password": "node scripts/rotate-password.mjs"`, `"check:secrets": "node scripts/check-secrets.mjs"`, `"test:secrets": "node --test test/livesync-config.test.mjs test/rotate-password.test.mjs test/check-secrets.test.mjs"`, and append `&& npm run test:secrets` to `test`.

- [ ] **Step 5: Rewrite the rotation documentation**

`README.md`: replace the three `wrangler secret put` lines under "Connection details page" with a pointer to `npm run rotate:password`, and replace the Operations rotation line. `docs/auto-deploy.md`: replace "Rotate the password" with the command, the warning that editing `COUCHDB_PASSWORD` in the dashboard breaks every device and the setup page at once, and the `npm run check:secrets` recovery.

- [ ] **Step 6: Run everything**

Run: `npm run test:secrets && npm run check:storage`
Expected: all pass; TypeScript unchanged.

- [ ] **Step 7: Commit**

```bash
git add package.json README.md docs/auto-deploy.md scripts/rotate-password.mjs scripts/check-secrets.mjs test/rotate-password.test.mjs
git commit -m "Expose rotation and drift checks as npm scripts"
```

---

### Task 7: Live verification

**Files:** none (operational).

- [ ] **Step 1: Confirm the deployment is currently consistent**

Run: `npm run check:secrets -- --vault /home/taxin/Documents/notes`
Expected: `server password`, `setup page gate` and `setup URI password` green;
`setup URI device profile` **red**, naming the ID derivation key, and
`vault connection` **red**, because the live legacy `encryptedCouchDBConnection`
still carries the pre-rotation password. Both red lines are real defects this
work found; do not "fix" them by editing config.

- [ ] **Step 2: Dry run**

Run: `npm run rotate:password -- --vault /home/taxin/Documents/notes --dry-run`
Expected: a summary naming the three secrets, the new URI host and database, the five verification steps, no secrets, and no changes to `data.json` (`git status` clean, file mtime unchanged).

- [ ] **Step 3: Ask the user before the real rotation**

The real run changes the live password and forces every paired device to re-pair. Post the dry-run summary and wait for an explicit go-ahead before running without `--dry-run`.

- [ ] **Step 4: Real rotation**

Close Obsidian, then `npm run rotate:password -- --vault /home/taxin/Documents/notes`. Expected: all steps pass, `check:secrets` afterwards is **fully green** (including `setup URI device profile`), `/vault` answers 200 with the new password and 401 with the old, and `docs`/`README` match the behaviour.

- [ ] **Step 5: Restart Obsidian and confirm sync**

Open the vault, wait for `↑ 0 ↓ 0`, then confirm a note edit round-trips.

- [ ] **Step 6: Final review**

Run `npm test && npm run check && npm run dry-run`. Report the diff and the green `check:secrets` table.
