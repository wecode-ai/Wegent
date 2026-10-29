#!/usr/bin/env bash
set -euo pipefail

source_digest="${SOURCE_DIGEST:?SOURCE_DIGEST is required}"
repository_owner="${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}"

# v3 rebuilds the API server and attachment examples against Ubuntu 24.04 GLIBC.
printf 'ghcr.io/%s/wegent-backend-rs-e2e:v3-noble-%s\n' \
  "${repository_owner,,}" "$source_digest"
