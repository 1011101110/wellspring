#!/usr/bin/env bash
# Push local .env values into GCP Secret Manager WITHOUT echoing them.
# Usage: scripts/load-secrets.sh [path-to-env-file]   (default: .env)
# Idempotent: creates the secret if absent, then adds a new version.
# Requires: gcloud authenticated, PROJECT set below.
set -euo pipefail

PROJECT="${GCP_PROJECT:-your-gcp-project-id}"
ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "No env file at $ENV_FILE"; exit 1; }

# Only these keys are treated as Secret Manager secrets.
SECRETS=(GLOO_CLIENT_ID GLOO_CLIENT_SECRET YOUVERSION_API_KEY \
  GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET RESEND_API_KEY \
  LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_URL ELEVENLABS_API_KEY)

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

for name in "${SECRETS[@]}"; do
  val="${!name:-}"
  if [ -z "$val" ]; then echo "skip  $name (empty)"; continue; fi
  if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$name" --project "$PROJECT" \
      --replication-policy=automatic >/dev/null
  fi
  printf '%s' "$val" | gcloud secrets versions add "$name" \
    --project "$PROJECT" --data-file=- >/dev/null
  echo "stored $name  (len=${#val})"   # length only, never the value
done
echo "Done. Grant kairos-api-sa secretAccessor per docs/06 §1 if not already."
