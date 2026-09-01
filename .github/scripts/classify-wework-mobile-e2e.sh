#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_mobile=false

if [[ "${1:-}" == "--all" ]]; then
  run_mobile=true
else
  while IFS= read -r path; do
    case "$path" in
      wework-mobile/* | \
        .github/workflows/wework-e2e.yml | \
        .github/actions/setup-python-uv-cache/* | \
        .github/actions/setup-python-uv-cache/**/* | \
        .github/scripts/build-wework-mobile-ios-app.sh | \
        .github/scripts/classify-wework-mobile-e2e.sh | \
        .github/scripts/create-wework-mobile-ios-simulator.sh | \
        pnpm-lock.yaml | \
        pyproject.toml | \
        uv.lock | \
        wework/codex-binaries.lock.json | \
        wework/e2e/desktop/* | \
        backend/alembic/* | \
        backend/app/* | \
        backend/pyproject.toml | \
        executor/*)
        run_mobile=true
        break
        ;;
    esac
  done
fi

matrix="$({
  cd "$repository_root"
  node --input-type=module - <<'NODE'
import { MOBILE_CHECKPOINT_SHARDS } from './wework-mobile/e2e/checkpoints.mjs'

console.log(JSON.stringify({
  include: MOBILE_CHECKPOINT_SHARDS.map(shard => ({
    id: shard.id,
    checkpoints: shard.checkpoints.join(','),
  })),
}))
NODE
})"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'wework_mobile_e2e=%s\n' "$run_mobile"
    printf 'wework_mobile_e2e_matrix=%s\n' "$matrix"
  } >> "$GITHUB_OUTPUT"
else
  printf 'wework_mobile_e2e=%s\n' "$run_mobile"
  printf 'wework_mobile_e2e_matrix=%s\n' "$matrix"
fi
