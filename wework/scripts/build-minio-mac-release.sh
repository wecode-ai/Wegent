#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
PROJECT_TAURI_TARGET_DIR="$WEWORK_DIR/src-tauri/target"

# shellcheck source=lib/wework-updater-signing.sh
source "$SCRIPT_DIR/lib/wework-updater-signing.sh"

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
  export VITE_API_BASE_URL="https://wegent.intra.weibo.com/api"
fi
if [ -n "$EXPLICIT_VITE_WEGENT_BACKEND_URL" ]; then
  export VITE_WEGENT_BACKEND_URL="$EXPLICIT_VITE_WEGENT_BACKEND_URL_VALUE"
else
  export VITE_WEGENT_BACKEND_URL="https://wegent.intra.weibo.com/api"
fi
if [ -n "$EXPLICIT_VITE_WEGENT_SOCKET_URL" ]; then
  export VITE_WEGENT_SOCKET_URL="$EXPLICIT_VITE_WEGENT_SOCKET_URL_VALUE"
fi
if [ -n "$EXPLICIT_VITE_WEWORK_FEEDBACK_URL" ]; then
  export VITE_WEWORK_FEEDBACK_URL="$EXPLICIT_VITE_WEWORK_FEEDBACK_URL_VALUE"
else
  export VITE_WEWORK_FEEDBACK_URL="https://wegent.intra.weibo.com/api/v1/feedback"
fi

VERSION=""
CHANNEL="stable"
RELEASE_NOTES=""
S3_ENDPOINT="${ATTACHMENT_S3_ENDPOINT:-}"
S3_BUCKET="${ATTACHMENT_S3_BUCKET:-}"
S3_PREFIX="${WEWORK_RELEASE_S3_PREFIX:-}"
UPDATE_MANIFEST_S3_PREFIX="${WEWORK_UPDATE_MANIFEST_S3_PREFIX:-${WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX:-wework/macos}}"
DEFAULT_OUTPUT_DIR="$WEWORK_DIR/src-tauri/target/release/minio-update"
OUTPUT_DIR="${WEWORK_RELEASE_OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}"
UPDATER_KEY_PATH="${WEWORK_UPDATER_KEY_PATH:-$HOME/.tauri/wework-internal-updater.key}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-aarch64-apple-darwin}"
BRAND_CONFIG="${WEWORK_BRAND_CONFIG:-}"
UPLOAD="false"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-minio-mac-release.sh --version <version> [options]

Build a Developer ID signed and notarized Wework macOS release whose updater
reads channel manifests and release artifacts directly from MinIO. Stable
releases also maintain latest.json for older clients.

Options:
  --version <version>       Release version, for example 0.1.12. Required.
  --channel <stable|beta>   Update channel. Default: stable.
  --beta                    Shorthand for --channel beta.
  --notes <text>            Release notes. Default: "Wework <version>".
  --endpoint <url>          S3 API endpoint. Defaults to ATTACHMENT_S3_ENDPOINT.
  --bucket <name>           S3 bucket. Defaults to ATTACHMENT_S3_BUCKET.
  --prefix <path>           Object prefix. Defaults by target architecture.
  --output-dir <path>       Local artifact directory.
  --macos-build-target <target>
                            Default: aarch64-apple-darwin.
  --brand-config <path>     Brand identity JSON used for this app bundle.
  --upload                  Upload artifacts with the backend MinIO SDK.
  -h, --help                Show this help message.

Environment:
  APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID, APPLE_SIGNING_IDENTITY
  ATTACHMENT_S3_ENDPOINT, ATTACHMENT_S3_BUCKET
  ATTACHMENT_S3_ACCESS_KEY, ATTACHMENT_S3_SECRET_KEY
  ATTACHMENT_S3_REGION, ATTACHMENT_S3_USE_SSL
  WEWORK_RELEASE_S3_PREFIX, WEWORK_MAC_ARM64_RELEASE_S3_PREFIX,
  WEWORK_MAC_X64_RELEASE_S3_PREFIX, WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX,
  WEWORK_UPDATE_MANIFEST_S3_PREFIX,
  WEWORK_RELEASE_OUTPUT_DIR, WEWORK_UPDATER_KEY_PATH,
  WEWORK_BRAND_CONFIG, VITE_API_BASE_URL, VITE_WEGENT_BACKEND_URL,
  VITE_WEGENT_SOCKET_URL, VITE_WEWORK_FEEDBACK_URL

Examples:
  bash wework/scripts/build-minio-mac-release.sh --version 0.1.12
  bash wework/scripts/build-minio-mac-release.sh --version 0.1.13-beta.1 --channel beta
  bash wework/scripts/build-minio-mac-release.sh --version 0.1.12 \
    --brand-config wework/branding/weibo.json
  bash wework/scripts/build-minio-mac-release.sh --version 0.1.12 --upload
EOF
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

normalize_prefix() {
  local value="$1"
  value="${value#/}"
  value="${value%/}"
  printf '%s\n' "$value"
}

default_s3_prefix() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin)
      printf '%s\n' "${WEWORK_MAC_ARM64_RELEASE_S3_PREFIX:-wework/macos}"
      ;;
    x86_64-apple-darwin)
      printf '%s\n' "${WEWORK_MAC_X64_RELEASE_S3_PREFIX:-wework/mac-x64}"
      ;;
    universal-apple-darwin)
      printf '%s\n' "${WEWORK_LEGACY_MACOS_RELEASE_S3_PREFIX:-wework/macos}"
      ;;
    *)
      echo "Unsupported macOS build target: $MACOS_BUILD_TARGET" >&2
      exit 1
      ;;
  esac
}

updater_platforms_for_target() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin)
      printf 'darwin-aarch64\n'
      ;;
    x86_64-apple-darwin)
      printf 'darwin-x86_64\n'
      ;;
    universal-apple-darwin)
      printf 'darwin-aarch64,darwin-x86_64\n'
      ;;
    *)
      echo "Unsupported macOS build target: $MACOS_BUILD_TARGET" >&2
      exit 1
      ;;
  esac
}

configure_release_credentials() {
  if [ -z "${MACOS_APP_SIGN_IDENTITY:-}" ]; then
    MACOS_APP_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
  fi
  export MACOS_APP_SIGN_IDENTITY
  export APPLE_BUILD_ID="${APPLE_BUILD_ID:-${APPLE_ID:-}}"
  export APPLE_BUILD_TEAM_ID="${APPLE_BUILD_TEAM_ID:-${APPLE_TEAM_ID:-}}"
  export APPLE_BUILD_PASSWORD="${APPLE_BUILD_PASSWORD:-${APPLE_PASSWORD:-}}"

  require_env MACOS_APP_SIGN_IDENTITY
  require_env APPLE_BUILD_ID
  require_env APPLE_BUILD_TEAM_ID
  require_env APPLE_BUILD_PASSWORD
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
  UPDATER_PLATFORMS="$(updater_platforms_for_target)" \
  RELEASE_VERSION="$VERSION" \
  RELEASE_CHANNEL="$CHANNEL" \
  RELEASE_OUTPUT_DIR="$OUTPUT_DIR" \
  uv run --project "$PROJECT_DIR/backend" \
    python "$SCRIPT_DIR/upload-mac-release-to-s3.py"
}

verify_uploaded_artifacts() {
  local archive_path
  local archive_url
  local dmg_filename
  local dmg_path
  local latest_dmg_url
  local platform

  archive_path="$(find "$OUTPUT_DIR" -maxdepth 1 -type f \
    -name "WeWork_${VERSION}_*.app.tar.gz" -print | sort | tail -1)"
  if [ -z "$archive_path" ]; then
    echo "No updater archive found for version $VERSION." >&2
    exit 1
  fi

  archive_url="$UPDATE_BASE_URL/$(basename "$archive_path")"
  dmg_path="$(find "$OUTPUT_DIR" -maxdepth 1 -type f \
    -name "WeWork_${VERSION}_*.dmg" -print | sort | tail -1)"
  if [ -z "$dmg_path" ]; then
    echo "No DMG found for version $VERSION." >&2
    exit 1
  fi
  dmg_filename="$(basename "$dmg_path")"
  latest_dmg_url="$UPDATE_BASE_URL/WeWork_latest_${dmg_filename#WeWork_"${VERSION}"_}"
  if ! curl -fsSI -o /dev/null "$archive_url"; then
    echo "MinIO upload succeeded, but updater files are not publicly readable." >&2
    echo "Allow unauthenticated GET access to: $UPDATE_BASE_URL" >&2
    exit 1
  fi
  for platform in $(updater_platforms_for_target | tr ',' ' '); do
    if ! curl -fsSI -o /dev/null "$UPDATE_MANIFEST_BASE_URL/$CHANNEL-$platform.json"; then
      echo "Channel manifest is not publicly readable: $UPDATE_MANIFEST_BASE_URL/$CHANNEL-$platform.json" >&2
      exit 1
    fi
  done
  if [ "$CHANNEL" = "stable" ]; then
    if ! curl -fsSI -o /dev/null "$UPDATE_BASE_URL/latest.json" || \
      ! curl -fsSI -o /dev/null "$latest_dmg_url"; then
      echo "Stable compatibility files are not publicly readable." >&2
      exit 1
    fi
    echo "Latest DMG: $latest_dmg_url"
  fi
}

generate_channel_manifests() {
  local platform
  local publish_channel

  for platform in $(updater_platforms_for_target | tr ',' ' '); do
    node "$SCRIPT_DIR/update-channel-manifests.mjs" \
      generate-platform "$OUTPUT_DIR/latest.json" "$OUTPUT_DIR" "$CHANNEL" "$platform"
    if [ "$CHANNEL" = "stable" ]; then
      publish_channel="beta"
      node "$SCRIPT_DIR/update-channel-manifests.mjs" \
        generate-platform "$OUTPUT_DIR/latest.json" "$OUTPUT_DIR" "$publish_channel" "$platform"
    fi
  done
}

promote_release_artifacts() {
  local build_output_dir="$1"
  local archive_path
  local dmg_path

  archive_path="$(find "$build_output_dir" -maxdepth 1 -type f \
    -name "WeWork_${VERSION}_*.app.tar.gz" -print | sort | tail -1)"
  dmg_path="$(find "$build_output_dir" -maxdepth 1 -type f \
    -name "WeWork_${VERSION}_*.dmg" -print | sort | tail -1)"

  if [ -z "$archive_path" ] || [ ! -s "$archive_path" ]; then
    echo "This build did not produce an updater archive for version $VERSION." >&2
    exit 1
  fi
  if [ ! -s "$archive_path.sig" ]; then
    echo "This build did not produce an updater signature: $archive_path.sig" >&2
    exit 1
  fi
  if [ -z "$dmg_path" ] || [ ! -s "$dmg_path" ]; then
    echo "This build did not produce a DMG for version $VERSION." >&2
    exit 1
  fi
  if [ ! -s "$build_output_dir/latest.json" ]; then
    echo "This build did not produce latest.json." >&2
    exit 1
  fi

  find "$OUTPUT_DIR" -maxdepth 1 -type f \
    -name "WeWork_${VERSION}_*" -delete
  find "$build_output_dir" -maxdepth 1 -type f ! -name latest.json \
    -exec cp -f {} "$OUTPUT_DIR/" \;
  cp -f "$build_output_dir/latest.json" "$OUTPUT_DIR/latest.json"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    beta|--beta)
      CHANNEL="beta"
      shift
      ;;
    stable|--stable)
      CHANNEL="stable"
      shift
      ;;
    --notes)
      RELEASE_NOTES="$2"
      shift 2
      ;;
    --endpoint)
      S3_ENDPOINT="$2"
      shift 2
      ;;
    --bucket)
      S3_BUCKET="$2"
      shift 2
      ;;
    --prefix)
      S3_PREFIX="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --macos-build-target)
      MACOS_BUILD_TARGET="$2"
      shift 2
      ;;
    --brand-config)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a config path." >&2
        usage >&2
        exit 1
      fi
      BRAND_CONFIG="$2"
      shift 2
      ;;
    --brand-config=*)
      BRAND_CONFIG="${1#*=}"
      shift
      ;;
    --upload)
      UPLOAD="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "--version is required." >&2
  usage >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[1-9][0-9]*)?$ ]]; then
  echo "--version must use MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-beta.N format. Got: $VERSION" >&2
  exit 1
fi
if [ "$CHANNEL" != "stable" ] && [ "$CHANNEL" != "beta" ]; then
  echo "--channel must be 'stable' or 'beta'. Got: $CHANNEL" >&2
  exit 1
fi
if [ "$CHANNEL" = "stable" ] && [[ "$VERSION" == *-beta.* ]]; then
  echo "A Beta version must be published with --channel beta. Got: $VERSION" >&2
  exit 1
fi
if [ -n "$BRAND_CONFIG" ]; then
  if [ ! -f "$BRAND_CONFIG" ]; then
    echo "Error: brand config not found: $BRAND_CONFIG" >&2
    exit 1
  fi
  BRAND_CONFIG="$(cd "$(dirname "$BRAND_CONFIG")" && pwd)/$(basename "$BRAND_CONFIG")"
fi
if [ -z "$S3_ENDPOINT" ]; then
  echo "--endpoint or ATTACHMENT_S3_ENDPOINT is required." >&2
  exit 1
fi
if [ -z "$S3_BUCKET" ]; then
  echo "--bucket or ATTACHMENT_S3_BUCKET is required." >&2
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
if [ -z "$S3_PREFIX" ]; then
  S3_PREFIX="$(default_s3_prefix)"
fi
S3_PREFIX="$(normalize_prefix "$S3_PREFIX")"
UPDATE_MANIFEST_S3_PREFIX="$(normalize_prefix "$UPDATE_MANIFEST_S3_PREFIX")"
UPDATE_BASE_URL="$S3_ENDPOINT/$S3_BUCKET"
if [ -n "$S3_PREFIX" ]; then
  UPDATE_BASE_URL="$UPDATE_BASE_URL/$S3_PREFIX"
fi
UPDATE_MANIFEST_BASE_URL="$S3_ENDPOINT/$S3_BUCKET"
if [ -n "$UPDATE_MANIFEST_S3_PREFIX" ]; then
  UPDATE_MANIFEST_BASE_URL="$UPDATE_MANIFEST_BASE_URL/$UPDATE_MANIFEST_S3_PREFIX"
fi
RELEASE_NOTES="${RELEASE_NOTES:-Wework $VERSION}"

configure_release_credentials
wework_configure_internal_updater_key "$PROJECT_DIR" "$UPDATER_KEY_PATH"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
BUILD_OUTPUT_DIR="$(mktemp -d "$OUTPUT_DIR/.build-${VERSION}.XXXXXX")"
cleanup_build_output() {
  rm -rf "$BUILD_OUTPUT_DIR"
}
trap cleanup_build_output EXIT

echo "Building Wework macOS MinIO release"
echo "  VERSION=$VERSION"
echo "  CHANNEL=$CHANNEL"
echo "  MACOS_BUILD_TARGET=$MACOS_BUILD_TARGET"
echo "  BRAND_CONFIG=${BRAND_CONFIG:-<default>}"
echo "  UPDATE_BASE_URL=$UPDATE_BASE_URL"
echo "  UPDATE_MANIFEST_BASE_URL=$UPDATE_MANIFEST_BASE_URL"
echo "  OUTPUT_DIR=$OUTPUT_DIR"
echo "  CARGO_TARGET_DIR=$PROJECT_TAURI_TARGET_DIR"
echo "  VITE_WEGENT_BACKEND_URL=$VITE_WEGENT_BACKEND_URL"
echo "  VITE_WEGENT_SOCKET_URL=${VITE_WEGENT_SOCKET_URL:-<backend URL>}"
echo "  VITE_WEWORK_FEEDBACK_URL=$VITE_WEWORK_FEEDBACK_URL"
echo "  UPLOAD=$UPLOAD"

RELEASE_ARGS=(
  --target local
  --version "$VERSION"
  --notes "$RELEASE_NOTES"
  --local-base-url "$UPDATE_BASE_URL"
  --updater-endpoint "$UPDATE_MANIFEST_BASE_URL/{{target}}-{{arch}}.json"
  --local-dist-dir "$BUILD_OUTPUT_DIR"
  --macos-build-target "$MACOS_BUILD_TARGET"
)
if [ -n "$BRAND_CONFIG" ]; then
  RELEASE_ARGS+=(--brand-config "$BRAND_CONFIG")
fi

if ! CARGO_TARGET_DIR="$PROJECT_TAURI_TARGET_DIR" \
  bash "$SCRIPT_DIR/release-mac-app.sh" "${RELEASE_ARGS[@]}"; then
  echo "macOS release build failed; refusing to upload existing artifacts." >&2
  exit 1
fi

promote_release_artifacts "$BUILD_OUTPUT_DIR"
generate_channel_manifests

if [ "$UPLOAD" = "true" ]; then
  upload_artifacts
  verify_uploaded_artifacts
  echo "Uploaded $CHANNEL updater manifest to: $UPDATE_BASE_URL"
else
  echo "Artifacts are ready in: $OUTPUT_DIR"
fi
