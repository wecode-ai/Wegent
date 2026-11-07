#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
classifier="$script_dir/classify-ci-changes.sh"
desktop_classifier="$script_dir/classify-wework-desktop-e2e.sh"
plugin_auth_classifier="$script_dir/classify-plugin-auth-sdk.sh"
cloud_checkpoint_flows="$repo_root/wework/e2e/desktop/modules/cloud-checkpoint-flows.mjs"
desktop_build_flows="$repo_root/wework/e2e/desktop/modules/desktop-build-flows.mjs"
desktop_checkpoint_runner="$repo_root/wework/e2e/desktop/run-checkpoints.mjs"
memory_tool_flows="$repo_root/wework/e2e/desktop/modules/memory-tool-flows.mjs"
notification_isolation_scenario="$repo_root/wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs"
backend_rs_runtime_inputs="hashFiles('backend-rs/Cargo.toml', 'backend-rs/Cargo.lock', 'backend-rs/src/**', 'backend-rs/crates/**', 'shared/rust/**', 'backend-rs/examples/**', 'backend-rs/migrations/**', 'shared/data/builtin-connector-apps.json', '.github/runtime-images/backend-rs-e2e.Dockerfile', '.github/runtime-images/backend-rs-builder.Dockerfile', '.github/ci/rust-toolchain', '.github/actions/setup-rust-cache/action.yml')"
# Discover test modules so new feature coverage does not edit this entry point.
for test_file in "$script_dir"/ci-classification-tests/*.sh; do
  source "$test_file"
done
