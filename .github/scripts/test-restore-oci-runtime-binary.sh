#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

mkdir -p "$temp_dir/bin"
cat > "$temp_dir/bin/skopeo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${TEST_FAIL_COPY:-false}" != true ]] || exit 1
count_file="${TEST_TEMP_DIR:?}/skopeo-count"
count=0
[[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
((count >= 2))
EOF
cat > "$temp_dir/bin/umoci" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${TEST_FAIL_UNPACK:-false}" != true ]] || exit 1
bundle="${@: -1}"
mkdir -p "$bundle/rootfs/app"
printf '#!/bin/sh\nexit 0\n' > "$bundle/rootfs/app/runtime"
EOF
chmod +x "$temp_dir/bin/skopeo" "$temp_dir/bin/umoci"

PATH="$temp_dir/bin:$PATH" \
  TEST_TEMP_DIR="$temp_dir" \
  OCI_RUNTIME_WAIT_SECONDS=5 \
  "$script_dir/restore-oci-runtime-binary.sh" \
  ghcr.io/example/runtime:test \
  /app/runtime \
  "$temp_dir/restored-runtime"

test -x "$temp_dir/restored-runtime"
test "$(cat "$temp_dir/skopeo-count")" -eq 2

for failure in copy unpack; do
  restore_status=0
  PATH="$temp_dir/bin:$PATH" \
    TEST_TEMP_DIR="$temp_dir" \
    TEST_FAIL_COPY="$([[ "$failure" == copy ]] && echo true || echo false)" \
    TEST_FAIL_UNPACK="$([[ "$failure" == unpack ]] && echo true || echo false)" \
    OCI_RUNTIME_WAIT_SECONDS=0 \
    "$script_dir/restore-oci-runtime-binary.sh" \
    ghcr.io/example/runtime:test /app/runtime "$temp_dir/$failure-runtime" || restore_status=$?
  if [[ "$failure" == copy ]]; then
    test "$restore_status" -eq 75
  else
    test "$restore_status" -eq 1
  fi
  test ! -e "$temp_dir/$failure-runtime"
done

printf 'OCI runtime restore tests passed\n'
