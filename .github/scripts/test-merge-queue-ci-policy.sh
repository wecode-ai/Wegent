#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workflow="$script_dir/../workflows/e2e-tests.yml"

fail() {
  printf 'Merge queue CI policy check failed: %s\n' "$1" >&2
  exit 1
}

platform_section="$(
  sed -n '/^  e2e-tests:/,/^  executor-e2e-tests:/p' "$workflow"
)"
report_section="$(
  sed -n '/^  merge-reports:/,/^  platform-e2e-summary:/p' "$workflow"
)"
summary_section="$(
  sed -n '/^  platform-e2e-summary:/,$p' "$workflow"
)"

if [[ "$(grep -Ec '^[[:space:]]+- shardIndex: [1-5]$' <<<"$platform_section")" -ne 5 ]] ||
  [[ "$(grep -Ec '^[[:space:]]+shardTotal: 5$' <<<"$platform_section")" -ne 5 ]]; then
  fail "Platform E2E must keep five parallel shards"
fi

# Provider-native files remain serial inside jobs with isolated databases. Keep
# every file exactly once and keep them away from the historically longest shard.
# shellcheck disable=SC2016
shard_expression='--shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}'
if [[ "$(grep -Fc -- "$shard_expression" <<<"$platform_section")" -ne 1 ]] ||
  [[ "$platform_section" != *"if: matrix.providerNativeSpec != ''"* ]] ||
  [[ "$platform_section" != *'--workers=1'* ]] ||
  [[ "$platform_section" != *'PLAYWRIGHT_BLOB_OUTPUT_FILE: blob-report/report-standard-'* ]] ||
  [[ "$platform_section" != *'PLAYWRIGHT_BLOB_OUTPUT_FILE: blob-report/report-provider-'* ]]; then
  fail "Platform and provider-native runs must preserve separate complete reports"
fi

for spec in \
  provider-native-chat.spec.ts \
  provider-native-dingtalk.spec.ts \
  provider-native-state-and-contract.spec.ts; do
  if [[ "$(grep -Fc "$spec" <<<"$platform_section")" -ne 1 ]]; then
    fail "$spec must run exactly once"
  fi
done

if sed -n '/shardIndex: 3/,/shardIndex: 4/p' <<<"$platform_section" |
  grep -Fq 'provider-native-'; then
  fail "The historically longest ordinary shard must not receive provider-native coverage"
fi

if [[ "$report_section" != *"github.event_name != 'merge_group'"* ]] ||
  [[ "$report_section" != *'pattern: blob-report-*'* ]] ||
  [[ "$report_section" != *'merge-multiple: true'* ]]; then
  fail "Merge queue must retain raw reports without waiting for merged HTML"
fi

# shellcheck disable=SC2016
report_required_expression="REPORT_REQUIRED: \${{ github.event_name != 'merge_group' }}"
# shellcheck disable=SC2016
report_required_guard='if [[ "$REPORT_REQUIRED" == "true" ]]'
if [[ "$summary_section" != *"$report_required_expression"* ]] ||
  [[ "$summary_section" != *"$report_required_guard"* ]]; then
  fail "Platform E2E summary must require merged HTML outside merge queue only"
fi

printf 'Merge queue CI policy tests passed\n'
