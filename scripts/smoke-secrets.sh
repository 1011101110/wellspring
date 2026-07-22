#!/usr/bin/env bash
# Verify credentials WORK without revealing them. Prints only PASS/FAIL per check.
# Usage: scripts/smoke-secrets.sh [path-to-env-file]   (default: .env)
set -uo pipefail
ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "No env file at $ENV_FILE"; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
fail=0

# --- Gloo: OAuth2 client-credentials token exchange ---
if [ -n "${GLOO_CLIENT_ID:-}" ] && [ -n "${GLOO_CLIENT_SECRET:-}" ]; then
  basic=$(printf '%s:%s' "$GLOO_CLIENT_ID" "$GLOO_CLIENT_SECRET" | base64 | tr -d '\n')
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    https://platform.ai.gloo.com/oauth2/token \
    -H "Authorization: Basic $basic" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=client_credentials&scope=api/access')
  [ "$code" = "200" ] && echo "PASS  Gloo token exchange" || { echo "FAIL  Gloo token exchange (HTTP $code)"; fail=1; }
else echo "skip  Gloo (no client id/secret)"; fi

# --- YouVersion: app-key auth against bibles list ---
if [ -n "${YOUVERSION_API_KEY:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    'https://api.youversion.com/v1/bibles?language_ranges[]=en' \
    -H "X-YVP-App-Key: $YOUVERSION_API_KEY")
  [ "$code" = "200" ] && echo "PASS  YouVersion app key" || { echo "FAIL  YouVersion app key (HTTP $code)"; fail=1; }
else echo "skip  YouVersion (no app key)"; fi

# --- Resend: key validity ---
if [ -n "${RESEND_API_KEY:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' https://api.resend.com/domains \
    -H "Authorization: Bearer $RESEND_API_KEY")
  [ "$code" = "200" ] && echo "PASS  Resend key" || { echo "FAIL  Resend key (HTTP $code)"; fail=1; }
else echo "skip  Resend (no key)"; fi

exit $fail
