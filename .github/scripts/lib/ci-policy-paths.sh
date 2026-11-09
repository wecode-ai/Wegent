#!/usr/bin/env bash

# Shared by module/SDK classification and feature planning. Keep one policy inventory.
CI_CONSUMER_PATHS=(
  '.github/ci/wework-unit-test-durations.json|wework'
  '.github/scripts/balance-wework-unit-tests.*|wework'
  'wework/scripts/ci-test-sequencer.*|wework'
  '.github/actions/build-frontend-e2e/*|platform_e2e'
  '.github/scripts/frontend-e2e-build*.mjs|platform_e2e'
  '.github/scripts/restore-frontend-ci-build.mjs|platform_e2e'
  '.github/actions/setup-node-workspace/*|frontend wework platform_e2e wework_e2e'
  '.github/actions/setup-rust-cache/*|backend_rs executor platform_e2e wework_e2e'
  '.github/actions/setup-sccache/*|backend_rs executor platform_e2e wework_e2e'
  '.github/ci/rust-toolchain|backend_rs executor platform_e2e wework_e2e'
  '.github/actions/build-wework-core-e2e/*|wework_e2e'
  '.github/actions/build-wework-windows-e2e/*|wework_e2e'
  '.github/actions/build-wework-macos-e2e/*|wework_e2e'
  '.github/actions/build-minio-e2e/*|wework_e2e'
  '.github/actions/setup-minio-e2e/*|wework_e2e'
  '.github/scripts/prepare-macos-inspector-e2e.sh|wework_e2e'
  '.github/scripts/build-macos-e2e-runtimes.sh|wework_e2e'
  '.github/scripts/macos-e2e-source-digest.mjs|wework_e2e'
  '.github/scripts/macos-e2e-build*.mjs|wework_e2e'
  '.github/scripts/restore-macos-ci-build.mjs|wework_e2e'
  '.github/scripts/restore-macos-e2e-runtime-oci.sh|wework_e2e'
  '.github/scripts/publish-macos-e2e-runtime-oci.sh|wework_e2e'
  '.github/ci/wework-linux-checkpoint-durations.json|wework_e2e'
  '.github/scripts/order-wework-linux-e2e.*|wework_e2e'
  '.github/scripts/core-runner-slots.*|wework_e2e'
  '.github/scripts/desktop-ci/*|wework_e2e'
  '.github/scripts/wework-core-e2e-transport.*|wework_e2e'
  '.github/scripts/verified-build-oci.mjs|platform_e2e wework_e2e'
  '.github/scripts/download-actions-artifact.sh|platform_e2e wework_e2e'
  '.github/scripts/restore-actions-runtime.sh|platform_e2e wework_e2e'
  '.github/scripts/runtime-artifact.mjs|platform_e2e wework_e2e'
  '.github/scripts/ci-prebuilt-images.mjs|platform_e2e wework_e2e'
  '.github/scripts/resolve-ci-image.mjs|platform_e2e wework_e2e'
  '.github/ci/prebuilt-images.json|platform_e2e wework_e2e'
  '.github/scripts/publish-ci-prebuild.sh|platform_e2e wework_e2e'
  '.github/scripts/restore-ci-downloads.sh|platform_e2e wework_e2e'
  '.github/runtime-images/*|platform_e2e wework_e2e'
  # These files are checked in the unconditional CI configuration gate.
  '.github/scripts/ci-scheduling.test.mjs|'
  '.github/scripts/runtime-artifact.test.mjs|'
  '.github/scripts/ci-prebuilt-images.test.mjs|'
  '.github/scripts/resolve-ci-image.test.mjs|'
  '.github/scripts/macos-e2e-source-digest.test.mjs|'
  '.github/scripts/test-rust-cache.sh|'
)

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
  '.github/scripts/ci-classification-tests/*'
)

ci_consumer_targets() {
  local path="$1" entry pattern
  for entry in "${CI_CONSUMER_PATHS[@]}"; do
    pattern="${entry%%|*}"
    if [[ "$path" == $pattern ]]; then
      printf '%s\n' "${entry#*|}"
      return 0
    fi
  done
  return 1
}

is_ci_policy_path() {
  local path="$1"
  local pattern
  if ci_consumer_targets "$path" >/dev/null; then
    return 1
  fi
  for pattern in "${CI_POLICY_PATHS[@]}"; do
    if [[ "$path" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --list) printf '%s\n' "${CI_POLICY_PATHS[@]}" ;;
    --list-consumers) printf '%s\n' "${CI_CONSUMER_PATHS[@]}" ;;
    *) printf 'Usage: %s --list | --list-consumers\n' "$0" >&2; exit 2 ;;
  esac
fi
