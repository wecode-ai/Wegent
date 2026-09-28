#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p \
  "$temp_dir/bin" \
  "$temp_dir/repository/executor" \
  "$temp_dir/repository/backend-rs"
touch \
  "$temp_dir/repository/executor/Cargo.toml" \
  "$temp_dir/repository/backend-rs/Cargo.toml"

cat >"$temp_dir/bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_CARGO_LOG"
if [[ "$*" == *"executor/Cargo.toml"* ]]; then
  output="$CARGO_TARGET_DIR/aarch64-apple-darwin/release/wegent-executor"
else
  output="$CARGO_TARGET_DIR/debug/wegent-backend-rs"
fi
mkdir -p "$(dirname "$output")"
printf '#!/usr/bin/env bash\nexit 0\n' > "$output"
chmod 0755 "$output"
EOF
chmod 0755 "$temp_dir/bin/cargo"

export PATH="$temp_dir/bin:$PATH"
export FAKE_CARGO_LOG="$temp_dir/cargo.log"
export WEWORK_EXECUTOR_TARGET_DIR="$temp_dir/executor-target"
export WEWORK_BACKEND_RS_TARGET_DIR="$temp_dir/backend-target"

executor_destination="$temp_dir/cache/wegent-executor"
backend_destination="$temp_dir/cache/wegent-backend-rs"

(
  cd "$temp_dir/repository"
  "$script_dir/build-macos-e2e-runtimes.sh" \
    "$executor_destination" \
    "$backend_destination"
)

test -x "$executor_destination"
test -x "$backend_destination"
test "$(wc -l < "$FAKE_CARGO_LOG" | tr -d ' ')" -eq 2

(
  cd "$temp_dir/repository"
  "$script_dir/build-macos-e2e-runtimes.sh" \
    "$executor_destination" \
    "$backend_destination"
)

test "$(wc -l < "$FAKE_CARGO_LOG" | tr -d ' ')" -eq 2
echo "macOS E2E runtime build tests passed"
