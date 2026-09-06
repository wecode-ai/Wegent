#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"

# shellcheck source=lib/wework-updater-signing.sh
source "$SCRIPT_DIR/lib/wework-updater-signing.sh"
# shellcheck source=lib/wework-release-notes.sh
source "$SCRIPT_DIR/lib/wework-release-notes.sh"
# shellcheck source=lib/wework-macos-signing.sh
source "$SCRIPT_DIR/lib/wework-macos-signing.sh"
# shellcheck source=lib/wework-update-channel.sh
source "$SCRIPT_DIR/lib/wework-update-channel.sh"
# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"

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
else
  export VITE_WEGENT_SOCKET_URL="${VITE_WEGENT_SOCKET_URL:-wss://wss-wegent.intra.weibo.com}"
fi
if [ -n "$EXPLICIT_VITE_WEWORK_FEEDBACK_URL" ]; then
  export VITE_WEWORK_FEEDBACK_URL="$EXPLICIT_VITE_WEWORK_FEEDBACK_URL_VALUE"
else
  export VITE_WEWORK_FEEDBACK_URL="${VITE_WEWORK_FEEDBACK_URL:-https://wegent.intra.weibo.com/api/v1/feedback}"
fi

VERSION=""
CHANNEL="stable"
RELEASE_KIND="${WEWORK_RELEASE_KIND:-full}"
RELEASE_NOTES=""
S3_ENDPOINT="${ATTACHMENT_S3_ENDPOINT:-}"
S3_BUCKET="${ATTACHMENT_S3_BUCKET:-}"
S3_PREFIX="${WEWORK_RELEASE_S3_PREFIX:-}"
COMPONENT_S3_PREFIX="${WEWORK_COMPONENT_S3_PREFIX:-wework/components}"
UPDATE_MANIFEST_S3_PREFIX="${WEWORK_UPDATE_MANIFEST_S3_PREFIX:-${WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX:-wework/macos}}"
OUTPUT_DIR="${WEWORK_RELEASE_OUTPUT_DIR:-$WEWORK_DIR/electron/release-minio}"
UPDATER_KEY_PATH="${WEWORK_UPDATER_KEY_PATH:-$HOME/.tauri/wework-internal-updater.key}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-aarch64-apple-darwin}"
BRAND_CONFIG="${WEWORK_BRAND_CONFIG:-$WEWORK_DIR/branding/weibo.json}"
UPLOAD="false"
RESUME_SIGNED_APP=""
SIGNED_APP_ONLY="false"
UPLOAD_EXISTING="false"
COMPONENTIZED_HOST_UPDATE="false"

configure_release_sccache() {
  local sccache_port=""
  local sccache_prefix="${WEWORK_RELEASE_SCCACHE_PREFIX:-wework/build-cache/sccache/$MACOS_BUILD_TARGET}"

  [ "${WEWORK_RELEASE_SCCACHE_S3:-false}" = "true" ] || return 0
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) sccache_port=42261 ;;
    x86_64-apple-darwin) sccache_port=42262 ;;
  esac

  require_command sccache
  require_env ATTACHMENT_S3_ACCESS_KEY
  require_env ATTACHMENT_S3_SECRET_KEY
  export SCCACHE_SERVER_PORT="${SCCACHE_SERVER_PORT:-$sccache_port}"
  configure_wegent_sccache_s3 \
    "$S3_ENDPOINT" \
    "$S3_BUCKET" \
    "$ATTACHMENT_S3_ACCESS_KEY" \
    "$ATTACHMENT_S3_SECRET_KEY" \
    "${ATTACHMENT_S3_REGION:-us-east-1}" \
    "$sccache_prefix"
  sccache --stop-server >/dev/null 2>&1 || true
}

configure_release_build_cache() {
  local cache_root="${WEWORK_RELEASE_CACHE_ROOT:-$HOME/Library/Caches/wegent/release-build}"

  export WEWORK_RELEASE_CACHE_ROOT="$cache_root"
  export ELECTRON_CACHE="${ELECTRON_CACHE:-$cache_root/electron}"
  export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$cache_root/electron-builder}"
  export ELECTRON_DOWNLOAD_CACHE_MODE="${ELECTRON_DOWNLOAD_CACHE_MODE:-0}"
  export WEGENT_CODEX_CACHE_DIR="${WEGENT_CODEX_CACHE_DIR:-$cache_root/codex}"
  export WEWORK_HARNESS_RUNTIME_CACHE_ROOT="${WEWORK_HARNESS_RUNTIME_CACHE_ROOT:-$cache_root/harness-runtime}"
  export WEGENT_CARGO_TARGET_ROOT="${WEGENT_CARGO_TARGET_ROOT:-$cache_root/cargo-target}"
  export SCCACHE_DIR="${SCCACHE_DIR:-$cache_root/sccache}"
  export pnpm_config_store_dir="${pnpm_config_store_dir:-$cache_root/pnpm-store}"

  mkdir -p \
    "$ELECTRON_CACHE" \
    "$ELECTRON_BUILDER_CACHE" \
    "$WEGENT_CODEX_CACHE_DIR" \
    "$WEWORK_HARNESS_RUNTIME_CACHE_ROOT" \
    "$WEGENT_CARGO_TARGET_ROOT" \
    "$SCCACHE_DIR" \
    "$pnpm_config_store_dir"

  configure_release_sccache
  configure_wegent_cargo_target_dir \
    "$PROJECT_DIR" \
    "wework-release-executor-$MACOS_BUILD_TARGET"
}

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-minio-mac-release.sh --version <version> [options]

Build the same signed Electron macOS release used by GitHub CI and optionally
publish either the full app update or only its independently updatable
components to MinIO.

Options:
  --version <version>       Release version. Required.
  --channel <stable|beta>   Update channel. Default: stable.
  --release-kind <kind>     full or component. Default: full.
  --beta                    Shorthand for --channel beta.
  --notes <text>            Release notes.
  --endpoint <url>          S3 API endpoint.
  --bucket <name>           S3 bucket.
  --prefix <path>           Object prefix. Defaults by architecture.
  --output-dir <path>       Local artifact directory.
  --macos-build-target <target>
                            aarch64-apple-darwin or x86_64-apple-darwin.
  --brand-config <path>     Brand identity and internal runtime defaults.
                            Default: wework/branding/weibo.json.
  --resume-signed-app <path>
                            Resume from an existing signed .app after a
                            notarization upload failure.
  --signed-app-only         Build and Developer ID sign the application, then
                            stop before notarization and installer packaging.
  --upload-existing        Upload and verify an existing release output
                            directory without rebuilding or repackaging.
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

release_platform() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) printf 'darwin-aarch64\n' ;;
    x86_64-apple-darwin) printf 'darwin-x86_64\n' ;;
  esac
}

installer_arch() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) printf 'mac-arm64\n' ;;
    x86_64-apple-darwin) printf 'mac\n' ;;
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
  WEWORK_COMPONENT_S3_PREFIX="$COMPONENT_S3_PREFIX" \
  WEWORK_UPDATE_MANIFEST_S3_PREFIX="$UPDATE_MANIFEST_S3_PREFIX" \
  WEWORK_MAC_ARM64_RELEASE_S3_PREFIX="$arm64_prefix" \
  WEWORK_MAC_X64_RELEASE_S3_PREFIX="$x64_prefix" \
  WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX="${WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX:-wework/macos}" \
  UPDATER_PLATFORMS="$(release_platform)" \
  RELEASE_VERSION="$VERSION" \
  RELEASE_SOURCE_SHA="$SOURCE_SHA" \
  RELEASE_CHANNEL="$CHANNEL" \
  RELEASE_KIND="$RELEASE_KIND" \
  RELEASE_OUTPUT_DIR="$OUTPUT_DIR" \
    uv run --script "$SCRIPT_DIR/upload-mac-release-to-s3.py"
}

verify_uploaded_artifacts() {
  local arch
  local component_manifest
  local electron_channel="$CHANNEL"
  local platform_manifest

  arch="$(release_arch)"
  component_manifest="components-$CHANNEL-macos-$arch.json"
  if ! curl -fsSI -o /dev/null "$UPDATE_BASE_URL/$component_manifest"; then
    echo "Published component manifest is not publicly readable: $UPDATE_BASE_URL/$component_manifest" >&2
    exit 1
  fi
  node "$SCRIPT_DIR/verify-minio-component-release.mjs" \
    "$UPDATE_BASE_URL" "$COMPONENT_BASE_URL" \
    "$VERSION" "$CHANNEL" macos "$arch"
  if [ "$RELEASE_KIND" = "component" ]; then
    return
  fi
  [ "$CHANNEL" = "stable" ] && electron_channel="latest"
  platform_manifest="$CHANNEL-$(release_platform).json"
  for url in \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_$(release_platform).dmg" \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_$(release_platform).zip" \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_$(release_platform).zip.blockmap" \
    "$UPDATE_BASE_URL/WeWorkHostUpdate_${VERSION}_$(release_platform).zip" \
    "$UPDATE_BASE_URL/WeWorkHostUpdate_${VERSION}_$(release_platform).zip.blockmap" \
    "$UPDATE_BASE_URL/$electron_channel-mac.yml" \
    "$UPDATE_MANIFEST_BASE_URL/$platform_manifest"; do
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
    --release-kind) RELEASE_KIND="$2"; shift 2 ;;
    beta|--beta) CHANNEL="beta"; shift ;;
    stable|--stable) CHANNEL="stable"; shift ;;
    --notes) RELEASE_NOTES="$(wework_decode_release_notes "$2")"; shift 2 ;;
    --endpoint) S3_ENDPOINT="$2"; shift 2 ;;
    --bucket) S3_BUCKET="$2"; shift 2 ;;
    --prefix) S3_PREFIX="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --macos-build-target) MACOS_BUILD_TARGET="$2"; shift 2 ;;
    --brand-config) BRAND_CONFIG="$2"; shift 2 ;;
    --resume-signed-app) RESUME_SIGNED_APP="$2"; shift 2 ;;
    --signed-app-only) SIGNED_APP_ONLY="true"; shift ;;
    --upload-existing) UPLOAD_EXISTING="true"; shift ;;
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
if [ "$RELEASE_KIND" != "full" ] && [ "$RELEASE_KIND" != "component" ]; then
  echo "--release-kind must be full or component." >&2
  exit 1
fi
if [ "$SIGNED_APP_ONLY" = "true" ] && [ -n "$RESUME_SIGNED_APP" ]; then
  echo "--signed-app-only cannot be combined with --resume-signed-app." >&2
  exit 1
fi
if [ "$SIGNED_APP_ONLY" = "true" ] && [ "$UPLOAD" = "true" ]; then
  echo "--signed-app-only cannot be combined with --upload." >&2
  exit 1
fi
if [ "$SIGNED_APP_ONLY" = "true" ] && [ "$RELEASE_KIND" != "full" ]; then
  echo "--signed-app-only requires --release-kind full." >&2
  exit 1
fi
if [ "$UPLOAD_EXISTING" = "true" ] && [ "$UPLOAD" != "true" ]; then
  echo "--upload-existing requires --upload." >&2
  exit 1
fi
if [ "$UPLOAD_EXISTING" = "true" ] && [ "$SIGNED_APP_ONLY" = "true" ]; then
  echo "--upload-existing cannot be combined with --signed-app-only." >&2
  exit 1
fi
if [ "$UPLOAD_EXISTING" = "true" ] && [ -n "$RESUME_SIGNED_APP" ]; then
  echo "--upload-existing cannot be combined with --resume-signed-app." >&2
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
if [ ! -f "$BRAND_CONFIG" ]; then
  echo "Brand config not found: $BRAND_CONFIG" >&2
  exit 1
fi

arch="$(release_arch)"
BRAND_CONFIG="$(cd "$(dirname "$BRAND_CONFIG")" && pwd)/$(basename "$BRAND_CONFIG")"
SOURCE_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
export WEWORK_BRAND_CONFIG="$BRAND_CONFIG"
export WEWORK_RELEASE_VERSION="$VERSION"
export WEWORK_SOURCE_SHA="$SOURCE_SHA"
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
COMPONENT_S3_PREFIX="$(normalize_prefix "$COMPONENT_S3_PREFIX")"
UPDATE_MANIFEST_S3_PREFIX="$(normalize_prefix "$UPDATE_MANIFEST_S3_PREFIX")"
UPDATE_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX"
COMPONENT_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$COMPONENT_S3_PREFIX"
UPDATE_MANIFEST_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$UPDATE_MANIFEST_S3_PREFIX"
if [ "$SIGNED_APP_ONLY" != "true" ] &&
  [ "$UPLOAD_EXISTING" != "true" ] &&
  [ -z "$RELEASE_NOTES" ]; then
  RELEASE_NOTES="$(
    cd "$PROJECT_DIR"
    GH_REPO='' RELEASE_SHA="$(git rev-parse HEAD)" RELEASE_VERSION="$VERSION" \
      RELEASE_NOTES_FORMAT=markdown node "$SCRIPT_DIR/generate-release-notes.mjs"
  )"
fi

require_command node
require_command uv
if [ "$UPLOAD_EXISTING" = "true" ]; then
  require_command curl
  if [ ! -d "$OUTPUT_DIR" ]; then
    echo "Existing release output directory not found: $OUTPUT_DIR" >&2
    exit 1
  fi
  upload_artifacts
  verify_uploaded_artifacts
  echo "Published existing MinIO $RELEASE_KIND release assets and update channels."
  exit 0
fi

require_command pnpm
configure_release_build_cache
if [ "$SIGNED_APP_ONLY" != "true" ]; then
  require_command curl
  wework_configure_internal_updater_key "$PROJECT_DIR" "$UPDATER_KEY_PATH"
  COMPONENTIZED_HOST_UPDATE="$(
    wework_resolve_componentized_host_update \
      "$UPDATE_BASE_URL/components-$CHANNEL-macos-$arch.json"
  )"
  if [ "$COMPONENTIZED_HOST_UPDATE" = "true" ]; then
    export WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS=false
  else
    export WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS=true
  fi
  echo "Componentized Host update enabled: $COMPONENTIZED_HOST_UPDATE"
fi

export APPLE_APP_SPECIFIC_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD:-${APPLE_PASSWORD:-}}"
if [ "$SIGNED_APP_ONLY" = "true" ]; then
  export WEWORK_RELEASE_DIR_ONLY=true
  export WEWORK_SKIP_MACOS_NOTARIZATION=true
else
  export WEWORK_CUSTOM_MACOS_NOTARIZATION=true
fi
export WEWORK_NOTARYTOOL_S3_ACCELERATION="${WEWORK_NOTARYTOOL_S3_ACCELERATION:-true}"
CSC_NAME="$(
  wework_normalize_macos_signing_identity \
    "${CSC_NAME:-${APPLE_SIGNING_IDENTITY:-}}"
)"
export CSC_NAME
if [ -z "${CSC_LINK:-}" ] && [ -z "$CSC_NAME" ]; then
  echo "CSC_LINK or APPLE_SIGNING_IDENTITY is required for a signed macOS release." >&2
  exit 1
fi

if [ -n "$RESUME_SIGNED_APP" ]; then
  if [ ! -d "$RESUME_SIGNED_APP" ] || [[ "$RESUME_SIGNED_APP" != *.app ]]; then
    echo "Signed macOS application not found: $RESUME_SIGNED_APP" >&2
    exit 1
  fi
  RESUME_SIGNED_APP="$(cd "$(dirname "$RESUME_SIGNED_APP")" && pwd)/$(basename "$RESUME_SIGNED_APP")"
  echo "Resuming Wework Electron macOS $arch release $VERSION from signed app"
  echo "Installing the locked Wework Electron workspace toolchain"
  pnpm --dir "$WEWORK_DIR/electron" install --frozen-lockfile
  node "$WEWORK_DIR/electron/scripts/notarize-macos.cjs" "$RESUME_SIGNED_APP"
  WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL" \
    node "$WEWORK_DIR/electron/scripts/package-prebuilt-macos-release.mjs" \
      "$RESUME_SIGNED_APP" "$arch"
else
  echo "Building Wework Electron macOS $arch release $VERSION ($CHANNEL)"
  CARGO_BUILD_TARGET="$MACOS_BUILD_TARGET" \
  WEWORK_RUNTIME_TARGET="$MACOS_BUILD_TARGET" \
  WEWORK_CODEX_TARGET="$MACOS_BUILD_TARGET" \
  WEWORK_DWS_TARGET="$MACOS_BUILD_TARGET" \
  WEWORK_RELEASE_PLATFORM=macos \
  WEWORK_RELEASE_ARCH="$arch" \
  WEWORK_SOURCE_SHA="$SOURCE_SHA" \
  WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL" \
  VITE_WEWORK_RELEASE_CHANNEL="$CHANNEL" \
  VITE_WEWORK_RUNTIME_MODE=local-first \
    pnpm --filter wework build:release
  if [ "$SIGNED_APP_ONLY" = "true" ]; then
    signed_app="$WEWORK_DIR/electron/release-installer/$(installer_arch)/Weibo WeWork.app"
    if [ ! -d "$signed_app" ]; then
      echo "Signed macOS application was not produced: $signed_app" >&2
      exit 1
    fi
    codesign --verify --deep --strict --verbose=2 "$signed_app"
    echo "Signed macOS application is ready: $signed_app"
    exit 0
  fi
fi

node "$SCRIPT_DIR/prepare-desktop-release-assets.mjs" \
  macos "$arch" "$VERSION" "$OUTPUT_DIR"
notes_path="$OUTPUT_DIR/WeWork_${VERSION}_$(release_platform).md"
printf '%s\n' "$RELEASE_NOTES" > "$notes_path"
WEWORK_RELEASE_BASE_URL="$UPDATE_BASE_URL" \
WEWORK_COMPONENT_BASE_URL="$COMPONENT_BASE_URL" \
WEWORK_USE_COMPONENTIZED_HOST_UPDATE="$COMPONENTIZED_HOST_UPDATE" \
WEWORK_RELEASE_TARGETS="macos-$arch" \
  node "$SCRIPT_DIR/generate-desktop-update-manifests.mjs" \
    "$OUTPUT_DIR" "$OUTPUT_DIR" "$VERSION" "$CHANNEL" \
    internal/minio "minio-$VERSION" "$notes_path" "$SOURCE_SHA"

if [ "$UPLOAD" = "true" ]; then
  require_command curl
  upload_artifacts
  verify_uploaded_artifacts
  echo "Published MinIO $RELEASE_KIND release assets and component update channels."
else
  echo "Release artifacts are ready in: $OUTPUT_DIR"
fi
