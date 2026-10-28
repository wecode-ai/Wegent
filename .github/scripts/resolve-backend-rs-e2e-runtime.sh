#!/usr/bin/env bash
set -euo pipefail

source_digest="${SOURCE_DIGEST:?SOURCE_DIGEST is required}"
repository_owner="${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"

# v2 contains both the API server and the attachment S3 verification binary.
printf 'ghcr.io/%s/wegent-backend-rs-e2e:v2-%s\n' \
  "${repository_owner,,}" "$source_digest"
