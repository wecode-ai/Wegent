#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$temp_dir/bin" "$temp_dir/registry" "$temp_dir/source"
cat >"$temp_dir/bin/oras" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

registry_path() {
  printf '%s/%s' "$FAKE_ORAS_REGISTRY" "$(printf '%s' "$1" | tr '/:' '__')"
}

case "$1" in
  manifest)
    test "$2" = "fetch"
    test -d "$(registry_path "$3")"
    ;;
  pull)
    test "$2" = "--output"
    destination="$3"
    source="$(registry_path "$4")"
    cp "$source"/* "$destination/"
    ;;
  push)
    test "$2" = "--artifact-type"
    reference="$4"
    layer="$5"
    source="${layer%%:*}"
    destination="$(registry_path "$reference")"
    mkdir -p "$destination"
    cp "$source" "$destination/"
    ;;
  *)
    echo "unexpected oras command: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 0755 "$temp_dir/bin/oras"

export PATH="$temp_dir/bin:$PATH"
export FAKE_ORAS_REGISTRY="$temp_dir/registry"

source_runtime="$temp_dir/source/wegent-executor"
printf '#!/usr/bin/env bash\nexit 0\n' > "$source_runtime"
chmod 0755 "$source_runtime"

source_reference="ghcr.io/wecode-ai/runtime:source"
head_reference="ghcr.io/wecode-ai/runtime:head"
"$script_dir/publish-macos-e2e-runtime-oci.sh" \
  "$source_runtime" \
  "$source_reference" \
  "$head_reference"

destination="$temp_dir/restored/wegent-executor"
"$script_dir/restore-macos-e2e-runtime-oci.sh" \
  "$destination" \
  wegent-executor \
  ghcr.io/wecode-ai/runtime:missing \
  "$head_reference"

test -x "$destination"
cmp "$source_runtime" "$destination"

printf '#!/usr/bin/env bash\nexit 9\n' > "$destination"
chmod 0755 "$destination"
"$script_dir/restore-macos-e2e-runtime-oci.sh" \
  "$destination" \
  wegent-executor \
  "$source_reference"
grep -Fq 'exit 9' "$destination"

echo "macOS E2E OCI runtime tests passed"
