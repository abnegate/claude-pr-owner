#!/usr/bin/env bash
# Usage: artifact.sh pack <directory> <file> | unpack <file> <directory>
# Artifacts of public repositories are public, so everything passed between jobs is encrypted
# with a key derived from a repository secret and the run id.
set -euo pipefail

if [[ -z "${ARTIFACT_SECRET_KEY:-}" ]]; then
  echo "::error::No credential is set to derive the artifact key from."
  exit 1
fi

PASSPHRASE=$(printf '%s' "$GITHUB_REPOSITORY/$GITHUB_RUN_ID" | openssl dgst -sha256 -hmac "$ARTIFACT_SECRET_KEY" -r | cut -d' ' -f1)
export PASSPHRASE

case "$1" in
  pack)
    tar -C "$2" -czf - . | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:PASSPHRASE -out "$3"
    ;;
  unpack)
    mkdir -p "$3"
    openssl enc -d -aes-256-cbc -pbkdf2 -pass env:PASSPHRASE -in "$2" | tar -C "$3" -xzf -
    ;;
  *)
    echo "::error::Unknown command '$1'."
    exit 1
    ;;
esac
