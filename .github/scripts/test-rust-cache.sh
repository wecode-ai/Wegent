#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
mkdir -p "$temporary/.github/ci"
cp "$root/.github/ci/rust-toolchain" "$temporary/.github/ci/"
ruby -ryaml - "$root" "$temporary/context.sh" <<'RUBY'
root, output = ARGV
action = YAML.load_file(File.join(root, '.github/actions/setup-rust-cache/action.yml'))
steps = action.fetch('runs').fetch('steps')
File.write(output, steps.find { |step| step['id'] == 'context' }.fetch('run'))
cache_steps = steps.select { |step| step['uses'].to_s.start_with?('actions/cache') }
raise 'Cargo sources must share a component-independent cache prefix' unless cache_steps.all? { |step|
  step.fetch('with').fetch('key').include?('-cargo-sources-v4-')
}
writer = cache_steps.find { |step| step['uses'].start_with?('actions/cache@') }
raise 'Only main may populate Rust sources' unless writer.fetch('if').include?("github.ref == 'refs/heads/main'")
workflow = YAML.load_file(File.join(root, '.github/workflows/test.yml'))
{'test-backend-rs' => 'backend-rs', 'test-executor' => 'executor', 'test-executor-local-auth-platforms' => 'executor'}.each do |job, component|
  setup = workflow.fetch('jobs').fetch(job).fetch('steps').find { |step|
    step['uses'] == './.github/actions/setup-rust-cache'
  }
  raise "#{job} bypasses the shared cache" unless setup&.fetch('with')&.fetch('manifest-path') == "#{component}/Cargo.toml"
end
warmup = YAML.load_file(File.join(root, '.github/workflows/ci-cache-warmup.yml'))
warm_steps = warmup.fetch('jobs').fetch('warm-executor-rust').fetch('steps')
%w[executor backend-rs].each do |component|
  raise "Missing #{component} compiler warmup" unless warm_steps.any? { |step|
    step['working-directory'] == component && step.fetch('run', '').include?('--no-run') && step.fetch('run', '').include?('cargo clippy')
  }
end
RUBY
for component in executor backend-rs; do
  : > "$temporary/output"
  : > "$temporary/environment"
  (cd "$temporary"; MANIFEST_PATH="$component/Cargo.toml" \
    RUNNER_TEMP=/runner-temp GITHUB_OUTPUT="$temporary/output" \
    GITHUB_ENV="$temporary/environment" bash context.sh)
  grep -Fxq "lockfile=$component/Cargo.lock" "$temporary/output"
  grep -Fxq "CARGO_TARGET_DIR=/runner-temp/$component-target" "$temporary/environment"
  grep -Fxq 'CARGO_PROFILE_TEST_DEBUG=0' "$temporary/environment"
  grep -Fxq 'CARGO_PROFILE_DEV_DEBUG=0' "$temporary/environment"
done
if (cd "$temporary"; MANIFEST_PATH=other/Cargo.toml bash context.sh); then
  echo 'Unknown component unexpectedly accepted' >&2
  exit 1
fi
printf 'Shared Rust toolchain/cache contracts passed\n'
