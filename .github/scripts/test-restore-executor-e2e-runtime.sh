#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin" "$temp_dir/artifacts"

# Keep the test independent of Docker while exercising real decompression.
cat > "$temp_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  load) cat >/dev/null ;;
  image) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$temp_dir/bin/docker"
export PATH="$temp_dir/bin:$PATH"
cd "$temp_dir"

assert_restore_fails() {
  if bash "$script_dir/restore-executor-e2e-runtime.sh" artifacts >output 2>&1; then
    printf 'Restore unexpectedly accepted %s\n' "$1" >&2
    exit 1
  fi
  if [[ -e executor/target/release/wegent-executor ]]; then
    printf 'Restore installed a binary from incomplete artifacts\n' >&2
    exit 1
  fi
}

assert_restore_fails 'missing image'
grep -Fq 'missing or empty: artifacts/e2e-claudecode-executor-image.tar.zst' output
printf 'image fixture' | zstd -q > artifacts/e2e-claudecode-executor-image.tar.zst
assert_restore_fails 'missing binary'
grep -Fq 'missing or empty: artifacts/wegent-executor' output
touch artifacts/wegent-executor
assert_restore_fails 'empty binary'
printf '#!/bin/sh\nexit 0\n' > artifacts/wegent-executor
cp artifacts/e2e-claudecode-executor-image.tar.zst complete-image
printf 'truncated image' > artifacts/e2e-claudecode-executor-image.tar.zst
assert_restore_fails 'corrupt image'
cp complete-image artifacts/e2e-claudecode-executor-image.tar.zst
bash "$script_dir/restore-executor-e2e-runtime.sh" artifacts
test -x executor/target/release/wegent-executor
cmp artifacts/wegent-executor executor/target/release/wegent-executor
printf 'Executor E2E artifact restore tests passed\n'
