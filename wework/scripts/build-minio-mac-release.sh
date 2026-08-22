#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"
PROJECT_TAURI_TARGET_DIR="$WEWORK_DIR/src-tauri/target"

# shellcheck source=lib/wework-updater-signing.sh
source "$SCRIPT_DIR/lib/wework-updater-signing.sh"
# shellcheck source=lib/wework-branding.sh
source "$SCRIPT_DIR/lib/wework-branding.sh"
# shellcheck source=lib/wework-macos-sidecar.sh
source "$SCRIPT_DIR/lib/wework-macos-sidecar.sh"
# shellcheck source=lib/wework-macos-signing.sh
source "$SCRIPT_DIR/lib/wework-macos-signing.sh"
# shellcheck source=lib/codex-code-statistics.sh
source "$SCRIPT_DIR/lib/codex-code-statistics.sh"

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
  --notes <text>            Release notes. Defaults to changes since the
                            previous Wework release.
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
  local runtime_asset

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
  while IFS= read -r runtime_asset; do
    if ! curl -fsSI -o /dev/null "$UPDATE_BASE_URL/$runtime_asset"; then
      echo "Runtime asset is not publicly readable: $UPDATE_BASE_URL/$runtime_asset" >&2
      exit 1
    fi
  done < <(
    node -e \
      "const m=require(process.argv[1]); for (const a of m.assets) { console.log(a.archiveName); console.log(a.descriptorName) }" \
      "$OUTPUT_DIR/release-runtime-assets.json"
  )
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

write_latest_manifest() {
  local archive_name="$1"
  local signature_path="$2"
  local platform

  platform="$(updater_platforms_for_target)"
  VERSION="$VERSION" \
  RELEASE_NOTES="$RELEASE_NOTES" \
  DOWNLOAD_URL="$UPDATE_BASE_URL/$archive_name" \
  SIGNATURE_PATH="$signature_path" \
  PLATFORM="$platform" \
  MANIFEST_PATH="$OUTPUT_DIR/latest.json" \
    uv run --project "$PROJECT_DIR/backend" python - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

data = {
    "version": os.environ["VERSION"],
    "notes": os.environ["RELEASE_NOTES"],
    "pub_date": datetime.now(timezone.utc)
    .replace(microsecond=0)
    .isoformat()
    .replace("+00:00", "Z"),
    "platforms": {
        os.environ["PLATFORM"]: {
            "signature": Path(os.environ["SIGNATURE_PATH"])
            .read_text(encoding="utf-8")
            .strip(),
            "url": os.environ["DOWNLOAD_URL"],
        }
    },
}
Path(os.environ["MANIFEST_PATH"]).write_text(
    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
}

sign_and_notarize_dmg() {
  local dmg_path="$1"
  local notary_result="$BUILD_CONFIG_DIR/notary-result.json"
  local notary_status
  local submission_id

  if [ -n "${MACOS_KEYCHAIN_PATH:-}" ]; then
    codesign --force --timestamp --keychain "$MACOS_KEYCHAIN_PATH" \
      --sign "$MACOS_APP_SIGN_IDENTITY" "$dmg_path"
  else
    codesign --force --timestamp --sign "$MACOS_APP_SIGN_IDENTITY" "$dmg_path"
  fi
  codesign --verify --strict --verbose=2 "$dmg_path"

  xcrun notarytool submit "$dmg_path" \
    --apple-id "$APPLE_BUILD_ID" \
    --team-id "$APPLE_BUILD_TEAM_ID" \
    --password "$APPLE_BUILD_PASSWORD" \
    --wait \
    --output-format json > "$notary_result"

  IFS=$'\t' read -r notary_status submission_id < <(
    NOTARY_RESULT="$notary_result" uv run --project "$PROJECT_DIR/backend" python - <<'PY'
import json
import os
from pathlib import Path

result = json.loads(Path(os.environ["NOTARY_RESULT"]).read_text())
print(result["status"], result.get("id", ""), sep="\t")
PY
  )
  if [ "$notary_status" != "Accepted" ]; then
    if [ -n "$submission_id" ]; then
      xcrun notarytool log "$submission_id" \
        --apple-id "$APPLE_BUILD_ID" \
        --team-id "$APPLE_BUILD_TEAM_ID" \
        --password "$APPLE_BUILD_PASSWORD" || true
    fi
    echo "Apple notarization did not accept the MinIO DMG." >&2
    exit 1
  fi
  xcrun stapler staple "$dmg_path"
  xcrun stapler validate "$dmg_path"
}

verify_runtime_descriptors_in_app() {
  local app_path="$1"
  local resource_root="$app_path/Contents/Resources"
  local descriptor

  for descriptor in \
    bundled-execution-runtimes/node.json \
    bundled-harness-runtime/runtimes.json; do
    if [ ! -s "$resource_root/$descriptor" ]; then
      echo "MinIO app bundle is missing runtime descriptor: $descriptor" >&2
      exit 1
    fi
  done
}

build_release_artifacts() {
  local archive_path
  local archive_name
  local app_path
  local bundle_root
  local config_override="$BUILD_CONFIG_DIR/tauri.minio.json"
  local dmg_path
  local dmg_name
  local insecure_transport="false"
  local release_config="$BUILD_CONFIG_DIR/tauri.release.json"

  if [[ "$UPDATE_BASE_URL" == http://* ]]; then
    insecure_transport="true"
  fi
  BASE_CONFIG="$WEWORK_DIR/src-tauri/tauri.conf.json" \
  CONFIG_OVERRIDE="$release_config" \
  VERSION="$VERSION" \
  UPDATER_ENDPOINT="$UPDATE_MANIFEST_BASE_URL/{{target}}-{{arch}}.json" \
  UPDATER_PUBKEY="$TAURI_UPDATER_PUBKEY" \
  SIGNING_IDENTITY="$MACOS_APP_SIGN_IDENTITY" \
  ENABLE_INSECURE_TRANSPORT="$insecure_transport" \
    node "$SCRIPT_DIR/generate-release-config.mjs"

  wework_prepare_brand_config \
    "$WEWORK_DIR" \
    "$BRAND_CONFIG" \
    "1" \
    "$config_override" \
    "$release_config"
  if [ -f "$config_override.namespace" ]; then
    WEWORK_EXECUTOR_NAMESPACE="$(<"$config_override.namespace")"
    export WEWORK_EXECUTOR_NAMESPACE
    rm -f "$config_override.namespace"
  fi

  wework_build_macos_executor_sidecar \
    "$PROJECT_DIR" \
    "$WEWORK_DIR" \
    "$MACOS_BUILD_TARGET" \
    release
  wework_build_code_statistics_hook "$WEWORK_DIR" "$MACOS_BUILD_TARGET"
  wework_sign_code_statistics_hook \
    "$WEWORK_DIR" \
    "$MACOS_BUILD_TARGET" \
    "$MACOS_APP_SIGN_IDENTITY"

  (
    cd "$WEWORK_DIR"
    WEWORK_CODEX_MATERIALIZE=1 \
      WEWORK_CODEX_TARGET="$MACOS_BUILD_TARGET" \
      pnpm run prepare:codex
    WEWORK_DWS_TARGET="$MACOS_BUILD_TARGET" pnpm run prepare:dws
  )
  wework_sign_prepared_codex_macos_binaries \
    "$WEWORK_DIR" \
    "$MACOS_BUILD_TARGET" \
    "$MACOS_APP_SIGN_IDENTITY"

  (
    cd "$WEWORK_DIR"
    CARGO_TARGET_DIR="$PROJECT_TAURI_TARGET_DIR" \
    WEWORK_HARNESS_RUNTIME_BASE_URL="$UPDATE_BASE_URL" \
    WEWORK_EXECUTION_RUNTIME_BASE_URL="$UPDATE_BASE_URL" \
    VITE_WEWORK_RELEASE_CHANNEL="$CHANNEL" \
    APPLE_SIGNING_IDENTITY="$MACOS_APP_SIGN_IDENTITY" \
      pnpm exec tauri build \
        --target "$MACOS_BUILD_TARGET" \
        --bundles app,dmg \
        --features release-devtools \
        --config "$config_override"
  )

  bundle_root="$PROJECT_TAURI_TARGET_DIR/$MACOS_BUILD_TARGET/release/bundle"
  app_path="$(find "$bundle_root/macos" -maxdepth 1 -type d -name '*.app' -print | sort | tail -1)"
  archive_path="$(find "$bundle_root/macos" -maxdepth 1 -type f -name '*.app.tar.gz' -print | sort | tail -1)"
  dmg_path="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' -print | sort | tail -1)"
  if [ -z "$app_path" ] || [ ! -d "$app_path" ]; then
    echo "MinIO build did not produce a macOS app bundle." >&2
    exit 1
  fi
  verify_runtime_descriptors_in_app "$app_path"
  wework_verify_macos_app_executor_sidecar "$bundle_root"
  wework_verify_code_statistics_hook "$bundle_root" "$MACOS_BUILD_TARGET"
  if [ -z "$archive_path" ] || [ ! -s "$archive_path" ] || [ ! -s "$archive_path.sig" ]; then
    echo "MinIO build did not produce a signed updater archive." >&2
    exit 1
  fi
  if [ -z "$dmg_path" ] || [ ! -s "$dmg_path" ]; then
    echo "MinIO build did not produce a DMG." >&2
    exit 1
  fi
  sign_and_notarize_dmg "$dmg_path"

  archive_name="WeWork_${VERSION}_$(updater_platforms_for_target).app.tar.gz"
  dmg_name="WeWork_${VERSION}_$(updater_platforms_for_target).dmg"
  find "$OUTPUT_DIR" -maxdepth 1 -type f -name "WeWork_${VERSION}_*" -delete
  cp -f "$archive_path" "$OUTPUT_DIR/$archive_name"
  cp -f "$archive_path.sig" "$OUTPUT_DIR/$archive_name.sig"
  cp -f "$dmg_path" "$OUTPUT_DIR/$dmg_name"
  printf '%s\n' "$RELEASE_NOTES" > "$OUTPUT_DIR/${archive_name%.app.tar.gz}.md"
  write_latest_manifest "$archive_name" "$OUTPUT_DIR/$archive_name.sig"
}

runtime_platform_for_target() {
  case "$MACOS_BUILD_TARGET" in
    aarch64-apple-darwin) printf 'macos-arm64\n' ;;
    x86_64-apple-darwin) printf 'macos-x64\n' ;;
    *)
      echo "MinIO releases follow the GitHub per-architecture flow; unsupported target: $MACOS_BUILD_TARGET" >&2
      exit 1
      ;;
  esac
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
if [ -z "$RELEASE_NOTES" ]; then
  RELEASE_NOTES="$(
    cd "$PROJECT_DIR"
    GH_REPO='' \
    RELEASE_SHA="$(git rev-parse HEAD)" \
    RELEASE_VERSION="$VERSION" \
    RELEASE_NOTES_FORMAT=markdown \
      node "$SCRIPT_DIR/generate-release-notes.mjs"
  )"
fi

configure_release_credentials
wework_configure_internal_updater_key "$PROJECT_DIR" "$UPDATER_KEY_PATH"
export APPLE_SIGNING_IDENTITY="$MACOS_APP_SIGN_IDENTITY"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
BUILD_CONFIG_DIR="$(mktemp -d "$OUTPUT_DIR/.config-${VERSION}.XXXXXX")"
cleanup_build_output() {
  rm -rf "$BUILD_CONFIG_DIR"
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

runtime_platform_for_target >/dev/null
build_release_artifacts
node "$SCRIPT_DIR/collect-release-runtime-assets.mjs" \
  "$OUTPUT_DIR" \
  "$UPDATE_BASE_URL" \
  "$(runtime_platform_for_target)"
generate_channel_manifests

if [ "$UPLOAD" = "true" ]; then
  upload_artifacts
  verify_uploaded_artifacts
  echo "Uploaded $CHANNEL updater manifest to: $UPDATE_BASE_URL"
else
  echo "Artifacts are ready in: $OUTPUT_DIR"
fi
