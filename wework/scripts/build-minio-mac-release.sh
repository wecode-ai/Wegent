#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"

# shellcheck source=lib/wework-updater-signing.sh
source "$SCRIPT_DIR/lib/wework-updater-signing.sh"
# shellcheck source=lib/wework-release-notes.sh
source "$SCRIPT_DIR/lib/wework-release-notes.sh"

EXPLICIT_VITE_API_BASE_URL="${VITE_API_BASE_URL+x}"
EXPLICIT_VITE_API_BASE_URL_VALUE="${VITE_API_BASE_URL:-}"
EXPLICIT_VITE_WEGENT_BACKEND_URL="${VITE_WEGENT_BACKEND_URL+x}"
EXPLICIT_VITE_WEGENT_BACKEND_URL_VALUE="${VITE_WEGENT_BACKEND_URL:-}"
EXPLICIT_VITE_WEGENT_SOCKET_URL="${VITE_WEGENT_SOCKET_URL+x}"
EXPLICIT_VITE_WEGENT_SOCKET_URL_VALUE="${VITE_WEGENT_SOCKET_URL:-}"
EXPLICIT_VITE_WEWORK_FEEDBACK_URL="${VITE_WEWORK_FEEDBACK_URL+x}"
EXPLICIT_VITE_WEWORK_FEEDBACK_URL_VALUE="${VITE_WEWORK_FEEDBACK_URL:-}"

for ENV_FILE in "$PROJECT_DIR/.env" "$WEWORK_DIR/.env.production"; do
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
done

if [ -n "$EXPLICIT_VITE_API_BASE_URL" ]; then
  export VITE_API_BASE_URL="$EXPLICIT_VITE_API_BASE_URL_VALUE"
else
  export VITE_API_BASE_URL="${VITE_API_BASE_URL:-https://wegent.intra.weibo.com/api}"
fi
if [ -n "$EXPLICIT_VITE_WEGENT_BACKEND_URL" ]; then
  export VITE_WEGENT_BACKEND_URL="$EXPLICIT_VITE_WEGENT_BACKEND_URL_VALUE"
else
  export VITE_WEGENT_BACKEND_URL="${VITE_WEGENT_BACKEND_URL:-https://wegent.intra.weibo.com/api}"
fi
if [ -n "$EXPLICIT_VITE_WEGENT_SOCKET_URL" ]; then
  export VITE_WEGENT_SOCKET_URL="$EXPLICIT_VITE_WEGENT_SOCKET_URL_VALUE"
fi
if [ -n "$EXPLICIT_VITE_WEWORK_FEEDBACK_URL" ]; then
  export VITE_WEWORK_FEEDBACK_URL="$EXPLICIT_VITE_WEWORK_FEEDBACK_URL_VALUE"
else
  export VITE_WEWORK_FEEDBACK_URL="${VITE_WEWORK_FEEDBACK_URL:-https://wegent.intra.weibo.com/api/v1/feedback}"
fi

VERSION=""
CHANNEL="stable"
RELEASE_NOTES=""
S3_ENDPOINT="${ATTACHMENT_S3_ENDPOINT:-}"
S3_BUCKET="${ATTACHMENT_S3_BUCKET:-}"
S3_PREFIX="${WEWORK_RELEASE_S3_PREFIX:-}"
UPDATE_MANIFEST_S3_PREFIX="${WEWORK_UPDATE_MANIFEST_S3_PREFIX:-${WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX:-wework/macos}}"
OUTPUT_DIR="${WEWORK_RELEASE_OUTPUT_DIR:-$WEWORK_DIR/electron/release-minio}"
UPDATER_KEY_PATH="${WEWORK_UPDATER_KEY_PATH:-$HOME/.tauri/wework-internal-updater.key}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-aarch64-apple-darwin}"
UPLOAD="false"
VERSION_BACKUP_DIR=""

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-minio-mac-release.sh --version <version> [options]

Build the same signed Electron macOS release used by GitHub CI, generate both
Electron updater YAML and a Tauri-signed migration bridge, and optionally
publish them to MinIO.

Options:
  --version <version>       Release version. Required.
  --channel <stable|beta>   Update channel. Default: stable.
  --beta                    Shorthand for --channel beta.
  --notes <text>            Release notes.
  --endpoint <url>          S3 API endpoint.
  --bucket <name>           S3 bucket.
  --prefix <path>           Object prefix. Defaults by architecture.
  --output-dir <path>       Local artifact directory.
  --macos-build-target <target>
                            aarch64-apple-darwin or x86_64-apple-darwin.
  --upload                  Upload artifacts and rolling manifests.
  -h, --help                Show this help message.

Signing environment:
  CSC_LINK, CSC_KEY_PASSWORD, APPLE_SIGNING_IDENTITY
  APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_TEAM_ID
  or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD (APPLE_PASSWORD is also accepted)

The Tauri updater private key signs only migration bridge assets for clients
installed before the Electron migration.
EOF
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

normalize_prefix() {
  local value="$1"
  value="${value#/}"
  value="${value%/}"
  printf '%s\n' "$value"
}

release_arch() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) printf 'arm64\n' ;;
    x86_64-apple-darwin) printf 'x64\n' ;;
    *)
      echo "Unsupported macOS build target: $MACOS_BUILD_TARGET" >&2
      exit 1
      ;;
  esac
}

legacy_platform() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) printf 'darwin-aarch64\n' ;;
    x86_64-apple-darwin) printf 'darwin-x86_64\n' ;;
  esac
}

default_s3_prefix() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin)
      printf '%s\n' "${WEWORK_MAC_ARM64_RELEASE_S3_PREFIX:-wework/macos}"
      ;;
    x86_64-apple-darwin)
      printf '%s\n' "${WEWORK_MAC_X64_RELEASE_S3_PREFIX:-wework/mac-x64}"
      ;;
  esac
}

restore_version_files() {
  if [ -n "$VERSION_BACKUP_DIR" ]; then
    cp -f "$VERSION_BACKUP_DIR/wework-package.json" "$WEWORK_DIR/package.json"
    cp -f "$VERSION_BACKUP_DIR/electron-package.json" "$WEWORK_DIR/electron/package.json"
    rm -rf "$VERSION_BACKUP_DIR"
  fi
}

upload_artifacts() {
  local arm64_prefix="${WEWORK_MAC_ARM64_RELEASE_S3_PREFIX:-wework/macos}"
  local x64_prefix="${WEWORK_MAC_X64_RELEASE_S3_PREFIX:-wework/mac-x64}"

  require_env ATTACHMENT_S3_ACCESS_KEY
  require_env ATTACHMENT_S3_SECRET_KEY
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) arm64_prefix="$S3_PREFIX" ;;
    x86_64-apple-darwin) x64_prefix="$S3_PREFIX" ;;
  esac

  ATTACHMENT_S3_ENDPOINT="$S3_ENDPOINT" \
  ATTACHMENT_S3_BUCKET="$S3_BUCKET" \
  WEWORK_RELEASE_S3_PREFIX="$S3_PREFIX" \
  WEWORK_UPDATE_MANIFEST_S3_PREFIX="$UPDATE_MANIFEST_S3_PREFIX" \
  WEWORK_MAC_ARM64_RELEASE_S3_PREFIX="$arm64_prefix" \
  WEWORK_MAC_X64_RELEASE_S3_PREFIX="$x64_prefix" \
  WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX="${WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX:-wework/macos}" \
  UPDATER_PLATFORMS="$(legacy_platform)" \
  RELEASE_VERSION="$VERSION" \
  RELEASE_CHANNEL="$CHANNEL" \
  RELEASE_OUTPUT_DIR="$OUTPUT_DIR" \
    uv run --project "$PROJECT_DIR/backend" \
      python "$SCRIPT_DIR/upload-mac-release-to-s3.py"
}

verify_uploaded_artifacts() {
  local arch
  local electron_channel="$CHANNEL"
  local legacy_manifest

  arch="$(release_arch)"
  [ "$CHANNEL" = "stable" ] && electron_channel="latest"
  legacy_manifest="$CHANNEL-$(legacy_platform).json"
  for url in \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_macos_${arch}.dmg" \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_macos_${arch}.zip" \
    "$UPDATE_BASE_URL/$electron_channel-mac.yml" \
    "$UPDATE_MANIFEST_BASE_URL/$legacy_manifest"; do
    if ! curl -fsSI -o /dev/null "$url"; then
      echo "Published release file is not publicly readable: $url" >&2
      exit 1
    fi
  done
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    beta|--beta) CHANNEL="beta"; shift ;;
    stable|--stable) CHANNEL="stable"; shift ;;
    --notes) RELEASE_NOTES="$(wework_decode_release_notes "$2")"; shift 2 ;;
    --endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --bucket) S3_BUCKET="$2"; shift 2 ;;
    --prefix) S3_PREFIX="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --macos-build-target) MACOS_BUILD_TARGET="$2"; shift 2 ;;
    --upload) UPLOAD="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "--version is required." >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[1-9][0-9]*)?$ ]]; then
  echo "Unsupported release version: $VERSION" >&2
  exit 1
fi
if [ "$CHANNEL" != "stable" ] && [ "$CHANNEL" != "beta" ]; then
  echo "--channel must be stable or beta." >&2
  exit 1
fi
if [ "$CHANNEL" = "stable" ] && [[ "$VERSION" == *-beta.* ]]; then
  echo "A beta version must be published to the beta channel." >&2
  exit 1
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS Electron releases must be built on a macOS host." >&2
  exit 1
fi

arch="$(release_arch)"
if [ -z "$S3_PREFIX" ]; then
  S3_PREFIX="$(default_s3_prefix)"
fi
if [ -z "$S3_ENDPOINT" ] || [ -z "$S3_BUCKET" ]; then
  echo "ATTACHMENT_S3_ENDPOINT and ATTACHMENT_S3_BUCKET are required." >&2
  exit 1
fi
if [[ "$S3_ENDPOINT" == *"/browser"* ]]; then
  echo "Use the MinIO S3 API endpoint, not the /browser console URL." >&2
  exit 1
fi
if [[ "$S3_ENDPOINT" != http://* ]] && [[ "$S3_ENDPOINT" != https://* ]]; then
  case "${ATTACHMENT_S3_USE_SSL:-true}" in
    false|False|FALSE|0|no|No|NO) S3_ENDPOINT="http://$S3_ENDPOINT" ;;
    *) S3_ENDPOINT="https://$S3_ENDPOINT" ;;
  esac
fi

S3_ENDPOINT="${S3_ENDPOINT%/}"
S3_PREFIX="$(normalize_prefix "$S3_PREFIX")"
UPDATE_MANIFEST_S3_PREFIX="$(normalize_prefix "$UPDATE_MANIFEST_S3_PREFIX")"
UPDATE_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX"
UPDATE_MANIFEST_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$UPDATE_MANIFEST_S3_PREFIX"
if [ -z "$RELEASE_NOTES" ]; then
  RELEASE_NOTES="$(
    cd "$PROJECT_DIR"
    GH_REPO='' RELEASE_SHA="$(git rev-parse HEAD)" RELEASE_VERSION="$VERSION" \
      RELEASE_NOTES_FORMAT=markdown node "$SCRIPT_DIR/generate-release-notes.mjs"
  )"
fi

require_command node
require_command pnpm
require_command uv
wework_configure_internal_updater_key "$PROJECT_DIR" "$UPDATER_KEY_PATH"

export APPLE_APP_SPECIFIC_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-${APPLE_PASSWORD:-}}"
export CSC_NAME="${CSC_NAME:-${APPLE_SIGNING_IDENTITY:-}}"
if [ -z "${CSC_LINK:-}" ] && [ -z "$CSC_NAME" ]; then
  echo "CSC_LINK or APPLE_SIGNING_IDENTITY is required for a signed macOS release." >&2
  exit 1
fi

VERSION_BACKUP_DIR="$(mktemp -d)"
trap restore_version_files EXIT
cp "$WEWORK_DIR/package.json" "$VERSION_BACKUP_DIR/wework-package.json"
cp "$WEWORK_DIR/electron/package.json" "$VERSION_BACKUP_DIR/electron-package.json"
node "$SCRIPT_DIR/sync-desktop-release-version.mjs" "$VERSION"

echo "Building Wework Electron macOS $arch release $VERSION ($CHANNEL)"
CARGO_BUILD_TARGET="$MACOS_BUILD_TARGET" \
WEWORK_RUNTIME_TARGET="$MACOS_BUILD_TARGET" \
WEWORK_CODEX_TARGET="$MACOS_BUILD_TARGET" \
WEWORK_DWS_TARGET="$MACOS_BUILD_TARGET" \
WEWORK_RELEASE_PLATFORM=macos \
WEWORK_RELEASE_ARCH="$arch" \
WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL" \
VITE_WEWORK_RELEASE_CHANNEL="$CHANNEL" \
VITE_WEWORK_RUNTIME_MODE=local-first \
  pnpm --filter wework build:release

node "$SCRIPT_DIR/prepare-desktop-release-assets.mjs" \
  macos "$arch" "$VERSION" "$OUTPUT_DIR"
notes_path="$OUTPUT_DIR/WeWork_${VERSION}_macos_${arch}.md"
printf '%s\n' "$RELEASE_NOTES" > "$notes_path"
WEWORK_RELEASE_BASE_URL="$UPDATE_BASE_URL" \
WEWORK_RELEASE_TARGETS="macos-$arch" \
  node "$SCRIPT_DIR/generate-desktop-update-manifests.mjs" \
    "$OUTPUT_DIR" "$OUTPUT_DIR" "$VERSION" "$CHANNEL" \
    internal/minio "minio-$VERSION" "$notes_path"

if [ "$UPLOAD" = "true" ]; then
  upload_artifacts
  verify_uploaded_artifacts
  echo "Published MinIO Electron and legacy Tauri update channels."
else
  echo "Release artifacts are ready in: $OUTPUT_DIR"
fi
