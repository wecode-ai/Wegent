#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"

# shellcheck source=lib/wework-updater-signing.sh
source "$SCRIPT_DIR/lib/wework-updater-signing.sh"
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
S3_PREFIX="${WEWORK_WINDOWS_RELEASE_S3_PREFIX:-wework/windows}"
DEFAULT_OUTPUT_DIR="$WEWORK_DIR/src-tauri/target/release/minio-windows-update"
OUTPUT_DIR="${WEWORK_WINDOWS_RELEASE_OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}"
UPDATER_KEY_PATH="${WEWORK_UPDATER_KEY_PATH:-$HOME/.tauri/wework-internal-updater.key}"
WINDOWS_BUILD_TARGET="${WINDOWS_BUILD_TARGET:-x86_64-pc-windows-msvc}"
CARGO_TARGET_DIR="${WEWORK_WINDOWS_CARGO_TARGET_DIR:-$WEWORK_DIR/src-tauri/target}"
BRAND_CONFIG="${WEWORK_BRAND_CONFIG:-}"
UPLOAD="false"
CONFIG_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-minio-windows-release.sh --version <version> [options]

Cross-build a Windows x64 NSIS installer with Tauri updater metadata and
optionally upload it to the internal MinIO release path.

Options:
  --version <version>       Release version, for example 0.1.17. Required.
  --channel <stable|beta>   Update channel. Default: stable.
  --beta                    Shorthand for --channel beta.
  --notes <text>            Release notes. Defaults to changes since the
                            previous Wework release.
  --endpoint <url>          S3 API endpoint. Defaults to ATTACHMENT_S3_ENDPOINT.
  --bucket <name>           S3 bucket. Defaults to ATTACHMENT_S3_BUCKET.
  --prefix <path>           Object prefix. Default: wework/windows.
  --output-dir <path>       Local artifact directory.
  --windows-build-target <target>
                            Default: x86_64-pc-windows-msvc.
  --brand-config <path>     Brand identity JSON used for this app bundle.
  --upload                  Upload artifacts and publish latest.json.
  -h, --help                Show this help message.

Required build tools:
  cargo-xwin, makensis, pnpm, uv

Environment:
  ATTACHMENT_S3_ENDPOINT, ATTACHMENT_S3_BUCKET
  ATTACHMENT_S3_ACCESS_KEY, ATTACHMENT_S3_SECRET_KEY
  ATTACHMENT_S3_REGION, ATTACHMENT_S3_USE_SSL
  WEWORK_WINDOWS_RELEASE_S3_PREFIX, WEWORK_WINDOWS_RELEASE_OUTPUT_DIR
  WEWORK_WINDOWS_CARGO_TARGET_DIR, WEWORK_UPDATER_KEY_PATH,
  WEWORK_BRAND_CONFIG, VITE_API_BASE_URL, VITE_WEGENT_BACKEND_URL,
  VITE_WEGENT_SOCKET_URL, VITE_WEWORK_FEEDBACK_URL

Example:
  bash wework/scripts/build-minio-windows-release.sh --version 0.1.17 --upload
  bash wework/scripts/build-minio-windows-release.sh \
    --version 0.1.18-beta.1 --channel beta --upload
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
  local name="$1"
  local install_hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name" >&2
    echo "$install_hint" >&2
    exit 1
  fi
}

normalize_prefix() {
  local value="$1"
  value="${value#/}"
  value="${value%/}"
  printf '%s\n' "$value"
}

create_release_config() {
  CONFIG_OVERRIDE="$(mktemp "$WEWORK_DIR/src-tauri/tauri.windows-release.json.XXXXXX")"
  VERSION="$VERSION" \
  UPDATER_ENDPOINT="$UPDATE_BASE_URL/{{target}}-{{arch}}.json" \
  UPDATER_PUBKEY="$TAURI_UPDATER_PUBKEY" \
  CONFIG_OVERRIDE="$CONFIG_OVERRIDE" \
    uv run --project "$PROJECT_DIR/backend" python - <<'PY'
import json
import os

config = {
    "version": os.environ["VERSION"],
    "bundle": {
        "createUpdaterArtifacts": True,
        "resources": [
            "binaries/codex/x86_64-pc-windows-msvc/**/*",
            "binaries/codex/legal/**/*",
            "bundled-execution-runtimes/*",
            "bundled-harness-runtime/*",
            "bundled-hooks/**/*",
            "bundled-plugins",
        ],
    },
    "plugins": {
        "updater": {
            "endpoints": [os.environ["UPDATER_ENDPOINT"]],
            "pubkey": os.environ["UPDATER_PUBKEY"],
            "dangerousInsecureTransportProtocol": True,
        },
    },
}

with open(os.environ["CONFIG_OVERRIDE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
}

find_installer() {
  find "$CARGO_TARGET_DIR/$WINDOWS_BUILD_TARGET/release/bundle/nsis" \
    -maxdepth 1 -type f -name '*.exe' -print | sort | tail -1
}

collect_release_artifacts() {
  local installer_path="$1"
  local release_installer="$OUTPUT_DIR/WeWork_${VERSION}_windows-x64-setup.exe"
  local release_signature="$release_installer.sig"

  mkdir -p "$OUTPUT_DIR"
  cp -f "$installer_path" "$release_installer"
  cp -f "$installer_path.sig" "$release_signature"
  printf '%s\n' "$RELEASE_NOTES" > "$OUTPUT_DIR/WeWork_${VERSION}_windows-x64.md"

  VERSION="$VERSION" \
  RELEASE_NOTES="$RELEASE_NOTES" \
  SIGNATURE_PATH="$release_signature" \
  INSTALLER_URL="$UPDATE_BASE_URL/$(basename "$release_installer")" \
  MANIFEST_PATH="$OUTPUT_DIR/latest.json" \
    uv run --project "$PROJECT_DIR/backend" python - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

signature = Path(os.environ["SIGNATURE_PATH"]).read_text(encoding="utf-8").strip()
data = {
    "version": os.environ["VERSION"],
    "notes": os.environ["RELEASE_NOTES"],
    "pub_date": datetime.now(timezone.utc)
    .replace(microsecond=0)
    .isoformat()
    .replace("+00:00", "Z"),
    "platforms": {
        "windows-x86_64": {
            "signature": signature,
            "url": os.environ["INSTALLER_URL"],
        },
    },
}

with open(os.environ["MANIFEST_PATH"], "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

  echo "Published Windows installer: $release_installer"
  echo "Published updater manifest: $OUTPUT_DIR/latest.json"
}

generate_channel_manifests() {
  node "$SCRIPT_DIR/update-channel-manifests.mjs" \
    generate-platform "$OUTPUT_DIR/latest.json" "$OUTPUT_DIR" "$CHANNEL" windows-x86_64
  if [ "$CHANNEL" = "stable" ]; then
    node "$SCRIPT_DIR/update-channel-manifests.mjs" \
      generate-platform "$OUTPUT_DIR/latest.json" "$OUTPUT_DIR" beta windows-x86_64
  fi
}

upload_artifacts() {
  require_env ATTACHMENT_S3_ACCESS_KEY
  require_env ATTACHMENT_S3_SECRET_KEY

  ATTACHMENT_S3_ENDPOINT="$S3_ENDPOINT" \
  ATTACHMENT_S3_BUCKET="$S3_BUCKET" \
  WEWORK_RELEASE_S3_PREFIX="$S3_PREFIX" \
  RELEASE_VERSION="$VERSION" \
  RELEASE_CHANNEL="$CHANNEL" \
  RELEASE_OUTPUT_DIR="$OUTPUT_DIR" \
    uv run --project "$PROJECT_DIR/backend" \
      python "$SCRIPT_DIR/upload-windows-release-to-s3.py"
}

verify_uploaded_artifacts() {
  local installer_url="$UPDATE_BASE_URL/WeWork_${VERSION}_windows-x64-setup.exe"
  local latest_installer_url="$UPDATE_BASE_URL/WeWork_latest_windows-x64-setup.exe"
  local channel_manifest_url="$UPDATE_BASE_URL/$CHANNEL-windows-x86_64.json"
  local runtime_asset

  if ! curl -fsSI -o /dev/null "$installer_url" || \
    ! curl -fsSI -o /dev/null "$channel_manifest_url"; then
    echo "MinIO upload succeeded, but Windows release files are not publicly readable." >&2
    echo "Allow unauthenticated GET access to: $UPDATE_BASE_URL" >&2
    exit 1
  fi
  if [ "$CHANNEL" = "stable" ]; then
    if ! curl -fsSI -o /dev/null "$UPDATE_BASE_URL/latest.json" || \
      ! curl -fsSI -o /dev/null "$latest_installer_url"; then
      echo "Stable compatibility files are not publicly readable." >&2
      exit 1
    fi
    echo "Latest Windows installer: $latest_installer_url"
  fi
  while IFS= read -r runtime_asset; do
    if ! curl -fsSI -o /dev/null "$UPDATE_BASE_URL/$runtime_asset"; then
      echo "Runtime asset is not publicly readable: $UPDATE_BASE_URL/$runtime_asset" >&2
      exit 1
    fi
  done < <(
    node -e \
      "const m=require(process.argv[1]); for (const a of m.assets) console.log(a.name)" \
      "$OUTPUT_DIR/release-runtime-assets.json"
  )
}

cleanup() {
  if [ -n "$CONFIG_OVERRIDE" ]; then
    rm -f "$CONFIG_OVERRIDE"
  fi
}
trap cleanup EXIT

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
    --windows-build-target)
      WINDOWS_BUILD_TARGET="$2"
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
if [ "$WINDOWS_BUILD_TARGET" != "x86_64-pc-windows-msvc" ]; then
  echo "Only x86_64-pc-windows-msvc is currently supported." >&2
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
S3_PREFIX="$(normalize_prefix "$S3_PREFIX")"
UPDATE_BASE_URL="$S3_ENDPOINT/$S3_BUCKET"
if [ -n "$S3_PREFIX" ]; then
  UPDATE_BASE_URL="$UPDATE_BASE_URL/$S3_PREFIX"
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

require_command cargo "Install Rust and cargo first."
require_command cargo-xwin "Install it with: cargo install cargo-xwin"
require_command makensis "On macOS install it with: brew install nsis"
require_command pnpm "Install pnpm before building Wework."
require_command uv "Install uv before running repository Python tools."

wework_configure_internal_updater_key "$PROJECT_DIR" "$UPDATER_KEY_PATH"
mkdir -p "$OUTPUT_DIR" "$CARGO_TARGET_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
CARGO_TARGET_DIR="$(cd "$CARGO_TARGET_DIR" && pwd)"
export CARGO_TARGET_DIR
create_release_config

echo "Building Wework Windows MinIO release"
echo "  VERSION=$VERSION"
echo "  CHANNEL=$CHANNEL"
echo "  WINDOWS_BUILD_TARGET=$WINDOWS_BUILD_TARGET"
echo "  BRAND_CONFIG=${BRAND_CONFIG:-<default>}"
echo "  UPDATE_BASE_URL=$UPDATE_BASE_URL"
echo "  OUTPUT_DIR=$OUTPUT_DIR"
echo "  VITE_API_BASE_URL=$VITE_API_BASE_URL"
echo "  VITE_WEGENT_BACKEND_URL=$VITE_WEGENT_BACKEND_URL"
echo "  VITE_WEGENT_SOCKET_URL=${VITE_WEGENT_SOCKET_URL:-<backend URL>}"
echo "  VITE_WEWORK_FEEDBACK_URL=$VITE_WEWORK_FEEDBACK_URL"
echo "  UPLOAD=$UPLOAD"

BUILD_ARGS=(
  --profile release
  --target "$WINDOWS_BUILD_TARGET"
  --bundles nsis
  --config "$CONFIG_OVERRIDE"
)
if [ -n "$BRAND_CONFIG" ]; then
  BUILD_ARGS+=(--brand-config "$BRAND_CONFIG")
fi

WEWORK_SKIP_ENV_FILE=1 \
WEWORK_HARNESS_RUNTIME_BASE_URL="$UPDATE_BASE_URL" \
WEWORK_EXECUTION_RUNTIME_BASE_URL="$UPDATE_BASE_URL" \
VITE_WEWORK_RELEASE_CHANNEL="$CHANNEL" \
  bash "$SCRIPT_DIR/build-windows-app.sh" "${BUILD_ARGS[@]}"

installer_script="$CARGO_TARGET_DIR/$WINDOWS_BUILD_TARGET/release/nsis/x64/installer.nsi"
if [ ! -f "$installer_script" ]; then
  echo "Windows NSIS installer script was not found: $installer_script" >&2
  exit 1
fi
wework_verify_windows_code_statistics_hook "$installer_script" "$WINDOWS_BUILD_TARGET"

installer_path="$(find_installer)"
if [ -z "$installer_path" ] || [ ! -f "$installer_path" ]; then
  echo "Windows NSIS installer was not found." >&2
  exit 1
fi
if [ ! -s "$installer_path.sig" ]; then
  echo "Tauri updater signature was not generated: $installer_path.sig" >&2
  exit 1
fi
collect_release_artifacts "$installer_path"
node "$SCRIPT_DIR/collect-release-runtime-assets.mjs" \
  "$OUTPUT_DIR" \
  "$UPDATE_BASE_URL" \
  windows-x64
generate_channel_manifests

if [ "$UPLOAD" = "true" ]; then
  upload_artifacts
  verify_uploaded_artifacts
  echo "Uploaded $CHANNEL updater manifest to: $UPDATE_BASE_URL"
else
  echo "Artifacts are ready in: $OUTPUT_DIR"
fi
