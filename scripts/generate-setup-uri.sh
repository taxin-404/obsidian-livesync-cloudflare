#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOST="${LIVESYNC_HOST:-}"
DB="${LIVESYNC_DB:-vault}"
USER_NAME="${LIVESYNC_USER:-admin}"
PASS="${LIVESYNC_PASS:-}"
VAULT_PASS="${LIVESYNC_PASSPHRASE:-}"
URI_MODE="${uri_mode:-persistent}"

if [[ -z "$HOST" ]]; then
  echo "usage: LIVESYNC_HOST=https://<worker>.<subdomain>.workers.dev $0" >&2
  exit 1
fi

if [[ -z "$PASS" && -f .dev.vars ]]; then
  PASS="$(sed -n 's/^COUCHDB_PASSWORD=//p' .dev.vars | head -1)"
fi
if [[ -z "$PASS" ]]; then
  echo "Set LIVESYNC_PASS, or put COUCHDB_PASSWORD in .dev.vars." >&2
  exit 1
fi

command -v deno >/dev/null 2>&1 || {
  echo "deno is required: https://deno.com" >&2
  exit 1
}

if [[ -z "$VAULT_PASS" ]]; then
  VAULT_PASS="$(openssl rand -hex 32)"
fi

out="$(LIVESYNC_HOST="$HOST" \
  LIVESYNC_DB="$DB" \
  LIVESYNC_USER="$USER_NAME" \
  LIVESYNC_PASS="$PASS" \
  LIVESYNC_PASSPHRASE="$VAULT_PASS" \
  uri_mode="$URI_MODE" \
  deno run --minimum-dependency-age=0 --allow-env \
  https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/utils/setup/generate_setup_uri.ts)"

uri="$(printf '%s\n' "$out" | grep -o 'obsidian://setuplivesync?settings=[^[:space:]]*' | tail -1)"
uri_pass="$(printf '%s\n' "$out" | sed -n 's/.*Setup URI is: //p' | tail -1)"
id_code="$(printf '%s\n' "$out" | sed -n 's/.*ID recovery code: //p' | tail -1)"

if [[ -z "$uri" ]]; then
  echo "Setup URI generation failed:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

umask 077
{
  echo "vault_passphrase=$VAULT_PASS"
  echo "uri_passphrase=$uri_pass"
  echo "id_recovery_code=$id_code"
  echo "uri=$uri"
} > .setup-uri

printf 'Setup URI saved to %s\n\n' "$PWD/.setup-uri"
printf 'Setup URI passphrase:  %s\n' "$uri_pass"
printf 'Vault E2EE passphrase: %s\n\n' "$VAULT_PASS"
printf 'Paste the URI into LiveSync -> Connect with Setup URI.\n'
printf 'Copy it with: sed -n "s/^uri=//p" .setup-uri | wl-copy   # or xclip\n'
