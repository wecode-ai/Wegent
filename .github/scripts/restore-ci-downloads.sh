#!/usr/bin/env bash
set -euo pipefail

owner="${GITHUB_REPOSITORY_OWNER:?registry owner is required}"
metadata="$(node .github/scripts/ci-prebuilt-images.mjs downloads "$owner")"
image="$(node -p 'JSON.parse(process.argv[1]).restoreImage' "$metadata")"
cache_root="${WEWORK_CI_DOWNLOAD_CACHE_DIR:-${HOME:?}/.cache/wegent}"
marker="$cache_root/ci-downloads-image"
if [[ -f "$marker" && "$(cat "$marker")" == "$image" ]]; then exit 0; fi
# Published download bundles are public. Fork tokens do not grant package access.
if ! skopeo inspect --no-creds "docker://$image" >/dev/null 2>&1; then
  echo "No published CI downloads for this input digest: $image"
  exit 0
fi
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
GITHUB_TOKEN='' GITHUB_ACTOR='' OCI_RUNTIME_WAIT_SECONDS=0 \
  .github/scripts/restore-oci-runtime-binary.sh "$image" /downloads.tar.gz "$temporary/downloads.tar.gz"
tar -tzf "$temporary/downloads.tar.gz" > "$temporary/inventory"
if grep -Ev '^(codex|electron-zips|minio)(/[^/]*)*/?$' "$temporary/inventory" |
  grep -q . || grep -Eq '(^|/)\.\.(/|$)' "$temporary/inventory"; then
  echo 'CI download bundle contains an unexpected path' >&2
  exit 1
fi
mkdir -p "$cache_root" "${RUNNER_TEMP:?}/wework-minio/bin"
tar -xzf "$temporary/downloads.tar.gz" -C "$temporary"
cp -a "$temporary/codex" "$temporary/electron-zips" "$cache_root/"
install -m 0755 "$temporary/minio/minio" "$RUNNER_TEMP/wework-minio/bin/minio"
"$RUNNER_TEMP/wework-minio/bin/minio" --version
printf '%s\n' "$image" > "$marker"
echo "Restored prebuilt Electron, Codex and MinIO downloads: $image"
