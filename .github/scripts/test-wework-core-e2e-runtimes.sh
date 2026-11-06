#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"
# shellcheck disable=SC2016 # Ruby evaluates the literal GitHub expressions.
ruby -ryaml -e '
  action = YAML.safe_load(File.read(ARGV[0]))
  step = action.fetch("runs").fetch("steps").find { |s| s["env"]&.key?("EXECUTOR_IMAGE") }
  artifact = step.fetch("env").fetch("RUNTIME_ARTIFACTS")
  raise "Desktop runtime consumers must not compile Rust" if step.fetch("run").match?(/cargo build|apt-get/)
  workflow = YAML.safe_load(File.read(ARGV[1]))
  producer = workflow.fetch("jobs").fetch("build-backend-rs-e2e-runtime")
  raise "Backend Rust binaries must target the Noble consumer GLIBC" unless producer.fetch("runs-on") == "ubuntu-24.04"
  consumer_workflow = YAML.safe_load(File.read(ARGV[2]))
  consumer_workflow.fetch("jobs").each do |name, job|
    job.fetch("steps", []).each do |candidate|
      next unless candidate["uses"]&.start_with?("actions/checkout@")
      options = candidate.fetch("with", {})
      next if options["fetch-depth"] == 0 || options.key?("sparse-checkout")
      raise "#{name} must fetch its complete shallow checkout without a second promisor fetch" if options.key?("filter")
    end
  end
  consumer = consumer_workflow.fetch("jobs").fetch("build-wework-desktop-core-e2e")
  permissions = consumer.fetch("permissions", consumer_workflow.fetch("permissions"))
  raise "Desktop runtime downloads need read-only Actions access" unless permissions.fetch("actions") == "read"
  raise "Desktop runtime consumers must not gain write permissions" if permissions.values.include?("write")
  warmup = YAML.safe_load(File.read(ARGV[3]))
  runtime_steps = [
    producer.fetch("steps").find { |s| s["name"] == "Resolve Backend Rust E2E runtime" },
    consumer_workflow.fetch("jobs").fetch("changes").fetch("steps").find { |s| s["name"] == "Resolve shared Rust E2E runtimes" },
    warmup.fetch("jobs").fetch("prepare-wework-desktop-image").fetch("steps").find { |s| s["name"] == "Resolve shared Rust E2E runtimes" }
  ]
  digests = runtime_steps.map { |s| s.fetch("env").fetch(s["env"].key?("SOURCE_DIGEST") ? "SOURCE_DIGEST" : "BACKEND_RS_SOURCE_DIGEST") }
  raise "Backend Rust OCI producer and consumers must hash the same inputs" unless digests.uniq.length == 1
  raise "Backend Rust OCI digest must include its example binaries" unless digests.first.include?("backend-rs/examples/**")
  recipe = ".github/runtime-images/backend-rs-e2e.Dockerfile"
  raise "Backend Rust OCI digest must include the image recipe" unless digests.first.include?(recipe)
  resolver = ".github/scripts/resolve-backend-rs-e2e-runtime.sh"
  raise "Backend Rust OCI references must use the shared resolver" unless runtime_steps.all? { |s| s.fetch("run").include?(resolver) }
  steps = producer.fetch("steps").to_h { |s| [s.fetch("name"), s] }
  build = steps.fetch("Build Backend Rust E2E runtime").fetch("run")
  builder_recipe = ".github/runtime-images/backend-rs-builder.Dockerfile"
  raise "Backend Rust must build with its hashed Noble recipe" unless build.include?("--file #{builder_recipe}") && digests.first.include?(builder_recipe)
  builder = File.read(File.join(File.dirname(ARGV[1]), "../runtime-images/backend-rs-builder.Dockerfile"))
  raise "Backend Rust builder must use Noble" unless builder.include?("FROM ubuntu:24.04")
  raise "Backend Rust must compile the attachment S3 example" unless builder.include?("--example attachment_s3_e2e")
  raise "Backend Rust must compile the attachment hosting example" unless builder.include?("--example attachment_hosting_e2e")
  publish = steps.fetch("Publish content-addressed Backend Rust E2E image")
  raise "Backend Rust image publication must use its hashed recipe" unless publish.fetch("run").include?("--file #{recipe}")
  dockerfile = File.read(File.join(File.dirname(ARGV[1]), "../runtime-images/backend-rs-e2e.Dockerfile"))
  copies = dockerfile.scan(/^COPY (\S+) (\/app\/\S+)$/)
  expected = [["wegent-backend-rs", "/app/wegent-backend-rs"], ["attachment-s3-e2e", "/app/attachment-s3-e2e"], ["attachment-hosting-e2e", "/app/attachment-hosting-e2e"]]
  raise "Backend Rust image must contain all runtime binaries" unless copies.sort == expected.sort
  builder_copy = "COPY shared/data/builtin-connector-apps.json ../shared/data/builtin-connector-apps.json"
  raise "Backend Rust builder must copy its compiled builtin connector data" unless builder.lines.map(&:strip).include?(builder_copy)
  raise "Backend Rust OCI digest must include compiled builtin connector data" unless digests.first.include?("shared/data/builtin-connector-apps.json")
  restore = steps.fetch("Restore content-addressed Backend Rust E2E binary").fetch("run")
  restored_paths = restore.scan(/"\$container_id:(\/app\/[^"]+)"/).flatten
  raise "Backend Rust cache hits must restore the published payload" unless restored_paths.sort == copies.map(&:last).sort
  upload = steps.fetch("Upload Backend Rust E2E runtime").fetch("with").fetch("path")
  expected.each do |name, _|
    raise "Backend Rust image omits #{name}" unless publish.fetch("run").include?(".ci-artifacts/backend-rs-image/#{name}")
    raise "Backend Rust artifact omits #{name}" unless upload.lines.map(&:strip).include?(".ci-artifacts/#{name}")
  end
  publish = publish.fetch("if")
  [consumer_workflow, warmup].each do |config|
    consumer_digests = config.fetch("jobs").values.flat_map { |job| job.fetch("steps", []) }
      .map { |s| s["env"]&.fetch("BACKEND_RS_SOURCE_DIGEST", nil) }.compact
      .select { |digest| digest.include?("backend-rs/src/**" + 39.chr) }
    raise "Missing shared Backend runtime digest" if consumer_digests.empty?
    raise "Backend runtime image producer and consumer digests differ" unless consumer_digests.all? { |digest| digest == digests.first }
  end
  producer_seconds = Integer(producer.fetch("timeout-minutes")) * 60
  consumer_seconds = Integer(consumer.fetch("timeout-minutes")) * 60
  oci_seconds = Integer(step.fetch("env").fetch("OCI_RUNTIME_WAIT_SECONDS"))
  executor_seconds = Integer(step.fetch("env").fetch("WEWORK_E2E_PREBUILT_EXECUTOR_WAIT_SECONDS"))
  raise "OCI wait must exceed the producer deadline" unless oci_seconds > producer_seconds
  raise "Executor wait must cover the OCI wait" unless executor_seconds >= oci_seconds
  raise "OCI wait must leave time within the consumer deadline" unless oci_seconds < consumer_seconds
  [["pull_request", "fork/Wegent", true, false],
   ["pull_request", "wecode-ai/Wegent", false, true],
   ["merge_group", "", false, true],
   ["schedule", "", false, true],
   ["workflow_dispatch", "", false, true]].each do |event, head, expected_artifact, expected_publish|
    expected_sha = event == "pull_request" ? "pr-head-sha" : "workflow-sha"
    values = {"github.event_name" => event, "github.event.pull_request.head.repo.full_name" => head,
              "github.repository" => "wecode-ai/Wegent", "steps.image-check.outputs.exists" => "false",
              "github.event.pull_request.head.sha" => event == "pull_request" ? expected_sha : nil,
              "github.sha" => "workflow-sha"}
    evaluate = lambda do |expression|
      expression = expression.gsub(/\$\{\{|\}\}/, "")
      values.each { |key, value| expression = expression.gsub(key, value.inspect) }
      eval(expression)
    end
    raise "wrong runtime artifact source for #{event}/#{head}" unless evaluate.call(artifact) == expected_artifact
    raise "wrong package publication for #{event}/#{head}" unless evaluate.call(publish) == expected_publish
    artifact_sha = step.fetch("env").fetch("RUNTIME_HEAD_SHA")
    raise "wrong runtime artifact revision for #{event}" unless evaluate.call(artifact_sha) == expected_sha
    [workflow, consumer_workflow].each do |definition|
      definition.fetch("jobs").each do |name, job|
        job.fetch("steps", []).select { |candidate| candidate["uses"]&.start_with?("actions/checkout@") }.each do |checkout|
          ref = checkout.fetch("with").fetch("ref")
          unless evaluate.call(ref) == expected_sha
            raise "#{name} checks out a different revision from the Executor artifact for #{event}"
          end
        end
      end
    end
  end
' "$script_dir/../actions/build-wework-core-e2e/action.yml" "$script_dir/../workflows/e2e-tests.yml" "$script_dir/../workflows/wework-e2e.yml" "$script_dir/../workflows/ci-cache-warmup.yml"
backend_image="$(
  SOURCE_DIGEST=source-digest GITHUB_REPOSITORY_OWNER=WECODE-AI \
    bash "$script_dir/resolve-backend-rs-e2e-runtime.sh"
)"
test "$backend_image" = "ghcr.io/wecode-ai/wegent-backend-rs-e2e:v3-noble-source-digest"
ruby -ryaml -e '
  action = YAML.safe_load(File.read(ARGV[0]))
  step = action.fetch("runs").fetch("steps").find { |s| s["env"]&.key?("EXECUTOR_IMAGE") }
  puts "set -euo pipefail"
  puts step.fetch("run")
' "${RUNTIME_ACTION_FILE:-$script_dir/../actions/build-wework-core-e2e/action.yml}" > "$temp_dir/build.sh"

cat > "$temp_dir/bin/cargo" <<'EOF'
#!/usr/bin/env bash
echo unexpected-build >> "$TEST_LOG"
exit 99
EOF
cat > "$temp_dir/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
echo unexpected-build >> "$TEST_LOG"
exit 99
EOF
cat > "$temp_dir/bin/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$*" = 'logout ghcr.io'
echo logout >> "$TEST_LOG"
[[ "$FAIL_LOGOUT" != true ]] || exit 1
rm "$DOCKER_CONFIG/config.json"
EOF
cat > "$temp_dir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test -z "${GITHUB_TOKEN:-}"
echo package >> "$TEST_LOG"
if [[ "$RUNTIME_ARTIFACTS" == true ]]; then
  test ! -f "$DOCKER_CONFIG/config.json"
  test -x .ci-artifacts/wegent-executor
  test -x .ci-artifacts/wegent-backend-rs
fi
[[ "$FAILURE" != package ]] || exit 1
for ((i=0; i<50; i++)); do
  if [[ -x .ci-artifacts/wegent-executor ]]; then
    mkdir -p wework/electron/release/WeWork-linux-x64/resources/bin
    cp .ci-artifacts/wegent-executor wework/electron/release/WeWork-linux-x64/WeWork
    cp .ci-artifacts/wegent-executor wework/electron/release/WeWork-linux-x64/resources/bin/wegent-executor
    exit 0
  fi
  sleep 0.1
done
exit 1
EOF
chmod +x "$temp_dir/bin/"*

run_case() {
  local mode="$1" failure="$2" expected="$3"
  local repo="$temp_dir/repo-$mode-$failure"
  mkdir -p "$repo/.github/scripts" "$repo/docker-config" "$repo/runtime-temp"
  cp "$script_dir/restore-actions-runtime.sh" "$script_dir/runtime-artifact.mjs" "$repo/.github/scripts/"
  printf '{"auths":{"ghcr.io":{"auth":"synthetic-credential"}}}\n' > "$repo/docker-config/config.json"
  touch "$repo/log"
  cat > "$repo/.github/scripts/restore-oci-runtime-binary.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_TOKEN:-}" = synthetic-read-token
test -f "$DOCKER_CONFIG/config.json"
test "$RUNTIME_ARTIFACTS" != true
case "$1 $2 $3" in
  'executor /app/executor .ci-artifacts/wegent-executor') ;;
  'backend /app/wegent-backend-rs .ci-artifacts/wegent-backend-rs') ;;
  *) exit 1 ;;
esac
echo "oci $3" >> "$TEST_LOG"
[[ "$FAILURE" != "$3" ]] || exit 1
mkdir -p "$(dirname "$3")"
printf '#!/bin/sh\nexit 0\n' > "$3"
chmod +x "$3"
EOF
  cat > "$repo/.github/scripts/download-actions-artifact.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_TOKEN:-}" = synthetic-read-token
test "$ACTIONS_ARTIFACT_WORKFLOW" = e2e-tests.yml
test "$ACTIONS_ARTIFACT_HEAD_SHA" = synthetic-head-sha
test "$ACTIONS_ARTIFACT_WAIT_SECONDS" = 1800
test -f "$DOCKER_CONFIG/config.json"
case "$1" in
  executor-e2e-binary) component=executor; binary=wegent-executor; image=executor ;;
  backend-rs-e2e-runtime) component=backend-rs; binary=wegent-backend-rs; image=backend ;;
  *) exit 1 ;;
esac
echo "artifact $1" >> "$TEST_LOG"
[[ "$FAILURE" != "$component" ]] || exit 1
mkdir -p "$2"
printf '#!/bin/sh\nexit 0\n' > "$2/$binary"
RUNTIME_HEAD_SHA="$ACTIONS_ARTIFACT_HEAD_SHA" node .github/scripts/runtime-artifact.mjs create "$2" "$component" "$image" "$binary"
if [[ "$FAILURE" == "missing:$binary" ]]; then
  rm "$2/$binary"
fi
if [[ "$FAILURE" == checksum && "$component" == backend-rs ]]; then
  printf corrupt > "$2/$binary"
fi
EOF
  chmod +x "$repo/.github/scripts/"*.sh
  local status=0
  (cd "$repo"; PATH="$temp_dir/bin:$PATH" TEST_LOG="$repo/log" \
    TMPDIR="$repo/runtime-temp" \
    RUNTIME_ARTIFACTS="$mode" RUNTIME_HEAD_SHA=synthetic-head-sha \
    FAILURE="$failure" FAIL_LOGOUT="$([[ "$failure" == logout ]] && echo true || echo false)" \
    DOCKER_CONFIG="$repo/docker-config" GITHUB_TOKEN=synthetic-read-token \
    EXECUTOR_IMAGE=executor BACKEND_RS_IMAGE=backend bash "$temp_dir/build.sh") || status=$?
  if [[ "$expected" == success ]]; then
    test "$status" -eq 0
    test -x "$repo/.ci-artifacts/wegent-backend-rs"
  else
    test "$status" -ne 0
    if [[ "$mode" == true && "$failure" != package ]] && grep -q package "$repo/log"; then return 1; fi
  fi
  if grep -q unexpected-build "$repo/log"; then return 1; fi
  test -z "$(find "$repo/.ci-artifacts" -type d -name '*-download.*' -print)"
  test -z "$(find "$repo/runtime-temp" -mindepth 1 -print)"
  if [[ "$mode" == true ]]; then
    if grep -q oci "$repo/log"; then return 1; fi
    test "$(grep -c artifact "$repo/log")" -eq 2
    if [[ "$expected" == success || "$failure" == package || "$failure" == logout ]]; then
      test "$(sed -n '3p' "$repo/log")" = logout
      if [[ "$failure" != logout ]]; then
        test ! -f "$repo/docker-config/config.json"
        test "$(sed -n '4p' "$repo/log")" = package
      fi
    fi
  else
    if grep -q logout "$repo/log"; then return 1; fi
    if grep -q '^artifact ' "$repo/log"; then return 1; fi
    test "$(grep -c oci "$repo/log")" -eq 2
  fi
}

run_case true none success
run_case false none success
run_case true executor failure
run_case true backend-rs failure
run_case true checksum failure
run_case true logout failure
run_case true missing:wegent-executor failure
run_case true missing:wegent-backend-rs failure
run_case true package failure
run_case false .ci-artifacts/wegent-executor failure
run_case false .ci-artifacts/wegent-backend-rs failure
run_case false package failure
echo 'Wework runtime artifact/OCI handoff tests passed'
