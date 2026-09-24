#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

mkdir -p "$temp_dir/bin" "$temp_dir/registry" "$temp_dir/repo"
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

archive_root="$temp_dir/archive"
mkdir -p "$archive_root"
archive="$archive_root/wework-core-e2e-build.tar.zst"
printf 'shared-build\n' >"$archive"
reference="ghcr.io/wecode-ai/wegent-wework-core-e2e-build:v1-source"
"$script_dir/publish-wework-core-e2e-build-oci.sh" "$archive" "$reference"

destination="$temp_dir/restored/wework-core-e2e-build.tar.zst"
"$script_dir/restore-wework-core-e2e-build-oci.sh" \
  "$destination" \
  ghcr.io/wecode-ai/wegent-wework-core-e2e-build:missing \
  "$reference"
cmp "$archive" "$destination"

if "$script_dir/restore-wework-core-e2e-build-oci.sh" \
  "$temp_dir/missing/wework-core-e2e-build.tar.zst" \
  ghcr.io/wecode-ai/wegent-wework-core-e2e-build:missing; then
  echo "Missing OCI build unexpectedly restored" >&2
  exit 1
fi

repo="$temp_dir/repo"
mkdir -p \
  "$repo/.github/actions/build-wework-core-e2e" \
  "$repo/.github/actions/setup-node-workspace" \
  "$repo/.github/scripts" \
  "$repo/packages/chat-core" \
  "$repo/wework/e2e" \
  "$repo/wework/src"
cp "$script_dir/resolve-wework-core-e2e-build-ref.sh" "$repo/.github/scripts/"
printf 'source\n' >"$repo/wework/src/app.ts"
printf 'scenario\n' >"$repo/wework/e2e/scenario.mjs"
printf '{}\n' >"$repo/package.json"
printf 'lock\n' >"$repo/pnpm-lock.yaml"
printf 'packages:\n' >"$repo/pnpm-workspace.yaml"
(
  cd "$repo"
  git init -q
  git add .
)

resolve_reference() {
  (
    cd "$repo"
    GITHUB_OUTPUT="$temp_dir/output" \
      .github/scripts/resolve-wework-core-e2e-build-ref.sh \
      wecode-ai \
      ghcr.io/wecode-ai/desktop:one \
      ghcr.io/wecode-ai/executor:one \
      ghcr.io/wecode-ai/backend:one
  )
  sed -n 's/^reference=//p' "$temp_dir/output" | tail -1
}

reference_before="$(resolve_reference)"
printf 'changed scenario\n' >"$repo/wework/e2e/scenario.mjs"
(cd "$repo" && git add wework/e2e/scenario.mjs)
reference_after_e2e="$(resolve_reference)"
test "$reference_before" = "$reference_after_e2e"

printf 'changed source\n' >"$repo/wework/src/app.ts"
(cd "$repo" && git add wework/src/app.ts)
reference_after_source="$(resolve_reference)"
test "$reference_before" != "$reference_after_source"

echo "Wework Core E2E OCI build tests passed"
