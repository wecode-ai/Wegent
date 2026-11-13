# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

assert_case "docs only" "$all_false" "docs/zh/index.md"

electron_cache_expected="${all_false/wework=false/wework=true}"
for path in .github/scripts/prime-ci-electron-installer-cache.mjs \
  .github/actions/prepare-electron-installer-cache/action.yml; do
  assert_case "Electron installer cache changes run both consumer workflows: $path" \
    "${electron_cache_expected/wework_e2e=false/wework_e2e=true}" "$path"
done

assert_case "DingTalk HTTPS fixture changes run platform E2E" \
  "${all_false/platform_e2e=false/platform_e2e=true}" \
  ".github/scripts/setup-dingtalk-oauth-e2e.sh"

e2e_apt_expected="${all_false/platform_e2e=false/platform_e2e=true}"
assert_case "E2E dependency installer changes run both consumer workflows" \
  "${e2e_apt_expected/wework_e2e=false/wework_e2e=true}" \
  ".github/scripts/install-e2e-apt-packages.sh"

permission_contract_expected="${all_false/backend=false/backend=true}"
assert_case "Chinese permission contract runs backend guards" "$permission_contract_expected" \
  "docs/zh/wegent/developer-guide/collaboration-permissions.md"
assert_case "English permission contract runs backend guards" "$permission_contract_expected" \
  "docs/en/wegent/developer-guide/collaboration-permissions.md"

rust_permission_expected="${permission_contract_expected/backend_rs=false/backend_rs=true}"
rust_permission_expected="${rust_permission_expected/platform_e2e=false/platform_e2e=true}"
rust_permission_expected="${rust_permission_expected/wework_e2e=false/wework_e2e=true}"
for path in backend-rs/src/cloud_projects.rs \
  backend-rs/src/cloud_projects/collaboration_access.sql \
  backend-rs/src/cloud_projects/environment_authorization.rs \
  backend-rs/src/cloud_projects/normalization.rs \
  backend-rs/src/loop_item_executions/device.rs \
  backend-rs/config/routes.toml; do
  assert_case "Rust permission changes run Rust, backend, and E2E guards: $path" \
    "$rust_permission_expected" "$path"
done

collaboration_package=$(
  cat <<'EOF'
backend=false
backend_rs=false
executor=false
executor_manager=false
shared=false
knowledge_engine=false
frontend=true
wework=true
wegent_cli=false
platform_e2e=true
wework_e2e=true
EOF
)

assert_case \
  "collaboration package" \
  "$collaboration_package" \
  "packages/collaboration/src/CollaborationApp.tsx"

process_explorer_package=$(
  cat <<'EOF'
backend=false
backend_rs=false
executor=false
executor_manager=false
shared=false
knowledge_engine=false
frontend=false
wework=true
wegent_cli=false
platform_e2e=false
wework_e2e=true
EOF
)
assert_case \
  "process explorer package" \
  "$process_explorer_package" \
  "packages/process-explorer/src/host/service.ts"

wework_expected="${all_false/wework=false/wework=true}"
wework_expected="${wework_expected/wework_e2e=false/wework_e2e=true}"
assert_case "wework only" "$wework_expected" "wework/src/App.tsx"

shared_expected=$(
  cat <<'EOF'
backend=true
backend_rs=false
executor=false
executor_manager=true
shared=true
knowledge_engine=true
frontend=false
wework=false
wegent_cli=true
platform_e2e=true
wework_e2e=false
EOF
)
assert_case "shared dependencies" "$shared_expected" "shared/utils/example.py"

backend_rs_expected="${all_false/backend_rs=false/backend_rs=true}"
backend_rs_expected="${backend_rs_expected/platform_e2e=false/platform_e2e=true}"
backend_rs_expected="${backend_rs_expected/wework_e2e=false/wework_e2e=true}"
assert_case "Rust backend changes run Rust contracts and both E2E suites" \
  "$backend_rs_expected" "backend-rs/src/decisions/mod.rs"

all_true="${all_false//false/true}"
assert_case "explicit all modules" "$all_true" --all

assert_case "workflow changes validate all modules" "$all_true" \
  ".github/workflows/test.yml"

rust_cache_expected="${backend_rs_expected/executor=false/executor=true}"
assert_case "Rust cache actions validate Rust and both runtime consumers" "$rust_cache_expected" \
  ".github/actions/setup-sccache/action.yml"

runtime_consumers="${all_false/platform_e2e=false/platform_e2e=true}"
runtime_consumers="${runtime_consumers/wework_e2e=false/wework_e2e=true}"
assert_case "artifact downloader validates its runtime producers and consumers" "$runtime_consumers" \
  ".github/scripts/download-actions-artifact.sh"
assert_case "verified OCI transport validates both complete-build consumers" "$runtime_consumers" \
  ".github/scripts/verified-build-oci.mjs"

assert_case "Node cache follows workspace and E2E consumers" "$collaboration_package" \
  ".github/actions/setup-node-workspace/action.yml"
for path in .github/actions/build-frontend-e2e/action.yml \
  .github/scripts/frontend-e2e-build.mjs .github/scripts/frontend-e2e-build-oci.mjs \
  .github/scripts/frontend-e2e-build.test.mjs .github/scripts/restore-frontend-ci-build.mjs; do
  assert_case "Frontend complete build validates its consumers: $path" \
    "${all_false/platform_e2e=false/platform_e2e=true}" "$path"
done
for path in .github/actions/build-wework-core-e2e/action.yml \
  .github/actions/build-wework-macos-e2e/action.yml \
  .github/actions/build-wework-windows-e2e/action.yml \
  .github/actions/build-minio-e2e/action.yml .github/actions/setup-minio-e2e/action.yml \
  .github/scripts/macos-e2e-build.mjs .github/scripts/macos-e2e-build.test.mjs \
  .github/scripts/restore-macos-ci-build.mjs; do
  assert_case "Desktop build actions select desktop consumers: $path" \
    "${all_false/wework_e2e=false/wework_e2e=true}" "$path"
done
for path in .github/ci/wework-unit-test-durations.json \
  .github/scripts/balance-wework-unit-tests.mjs wework/scripts/ci-test-sequencer.mjs \
  wework/scripts/ci-test-sequencer.test.mjs; do
  assert_case "Unit scheduling changes select the existing unit suite: $path" \
    "${all_false/wework=false/wework=true}" "$path"
done
assert_case "Unknown shared actions remain conservative" "$all_true" \
  ".github/actions/future-shared-action/action.yml"
assert_case "Runtime contract fixtures run in the unconditional configuration gate" "$all_false" \
  ".github/scripts/runtime-artifact.test.mjs"

assert_case "shared apt helper validates all modules" "$all_true" \
  ".github/scripts/lib/apt-packages.sh"

assert_case "cache policy helper validates all modules" "$all_true" \
  ".github/scripts/lib/validate-ci-cache-policy.rb"

assert_case "cache warmup classifier validates all modules" "$all_true" \
  ".github/scripts/classify-ci-cache-warmup.sh"

assert_case "cache policy changes validate all modules" "$all_true" \
  ".github/scripts/test-ci-cache-policy.sh"

assert_case "release workflow changes validate all modules" "$all_true" \
  ".github/workflows/publish-image.yml"

assert_case "base image workflow changes validate all modules" "$all_true" \
  ".github/workflows/publish-base-image.yml"

assert_case "cache warmup changes validate all modules" "$all_true" \
  ".github/workflows/ci-cache-warmup.yml"

assert_case "ci:all label forces all modules" "$all_true" --all

platform_e2e_expected="${all_false/platform_e2e=false/platform_e2e=true}"
assert_case "docker changes run platform E2E" "$platform_e2e_expected" \
  "docker/docker-compose.yml"
assert_case "knowledge provider lifecycle changes run platform E2E" "$platform_e2e_expected" \
  ".github/scripts/run-knowledge-provider-e2e.sh"

executor_dependency_expected="${platform_e2e_expected/executor=false/executor=true}"
assert_case "executor dependency setup changes run executor and platform E2E" \
  "$executor_dependency_expected" \
  ".github/scripts/install-executor-rust-system-dependencies.sh"

assert_case "executor E2E resolver changes run platform E2E" \
  "$platform_e2e_expected" \
  ".github/scripts/resolve-executor-e2e-runtime.sh"

wework_e2e_expected="${all_false/wework_e2e=false/wework_e2e=true}"
assert_case "Wework workflow changes run Wework E2E" "$wework_e2e_expected" \
  ".github/workflows/wework-e2e.yml"

assert_case "Wework artifact scripts run Wework E2E" "$wework_e2e_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

assert_case "Wework transport retains E2E coverage" "$wework_e2e_expected" \
  ".github/scripts/wework-core-e2e-transport.mjs"

assert_case "Wework E2E image changes run Wework E2E" "$wework_e2e_expected" \
  "docker/wework-e2e/desktop.Dockerfile"

for path in .github/actions/setup-wework-native-test-dependencies/action.yml \
  .github/ci/wework-native-test-ubuntu.sources; do
  assert_case "Native desktop preparation selects its CI consumers: $path" \
    "$wework_e2e_expected" "$path"
done

shared_rust_expected="${backend_rs_expected/executor=false/executor=true}"
assert_case "shared Rust libraries run both consumers" "$shared_rust_expected" \
  "shared/rust/crypto/src/lib.rs"
