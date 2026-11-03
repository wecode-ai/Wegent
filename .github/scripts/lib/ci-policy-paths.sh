#!/usr/bin/env bash

# Shared by module/SDK classification and feature planning. Keep one policy inventory.
CI_POLICY_PATHS=(
  '.github/ci/*'
  '.github/actions/*'
  '.github/workflows/lint.yml'
  '.github/workflows/test.yml'
  '.github/workflows/e2e-tests.yml'
  '.github/workflows/wework-e2e.yml'
  '.github/workflows/plugin-auth-sdk.yml'
  '.github/workflows/ci-feature-labels.yml'
  '.github/workflows/ci-cache-warmup.yml'
  '.github/workflows/publish-base-image.yml'
  '.github/workflows/publish-image.yml'
  '.github/workflows/snapshot-image.yml'
  '.github/workflows/wework-app.yml'
  '.github/scripts/classify-ci-cache-warmup.sh'
  '.github/scripts/classify-ci-changes.sh'
  '.github/scripts/classify-plugin-auth-sdk.sh'
  '.github/scripts/classify-wework-desktop-e2e.sh'
  '.github/scripts/ci-feature-catalog.mjs'
  '.github/scripts/ci-feature-plan.mjs'
  '.github/scripts/ci-feature-policy.mjs'
  '.github/scripts/check-ci-feature-plan.mjs'
  '.github/scripts/run-feature-playwright.mjs'
  '.github/scripts/sync-ci-feature-labels.mjs'
  '.github/scripts/download-actions-artifact.sh'
  '.github/scripts/lib/apt-packages.sh'
  '.github/scripts/lib/validate-ci-cache-policy.rb'
  '.github/scripts/lib/ci-policy-paths.sh'
  '.github/scripts/test-ci-cache-policy.sh'
  '.github/scripts/test-classify-ci-changes.sh'
)

is_ci_policy_path() {
  local path="$1"
  local pattern
  for pattern in "${CI_POLICY_PATHS[@]}"; do
    if [[ "$path" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" != "--list" ]]; then
    printf 'Usage: %s --list\n' "$0" >&2
    exit 2
  fi
  printf '%s\n' "${CI_POLICY_PATHS[@]}"
fi
