#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$WEWORK_DIR/.." && pwd)"

# shellcheck source=lib/wework-release-notes.sh
source "$SCRIPT_DIR/lib/wework-release-notes.sh"
# shellcheck source=lib/wework-update-channel.sh
source "$SCRIPT_DIR/lib/wework-update-channel.sh"

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
S3_PREFIX="${WEWORK_WINDOWS_RELEASE_S3_PREFIX:-wework/windows}"
COMPONENT_S3_PREFIX="${WEWORK_COMPONENT_S3_PREFIX:-wework/components}"
OUTPUT_DIR="${WEWORK_WINDOWS_RELEASE_OUTPUT_DIR:-$WEWORK_DIR/electron/release-minio}"
WINDOWS_BUILD_TARGET="${WINDOWS_BUILD_TARGET:-x86_64-pc-windows-msvc}"
BRAND_CONFIG="${WEWORK_BRAND_CONFIG:-$WEWORK_DIR/branding/weibo.json}"
UPLOAD="false"
UNSIGNED="false"
COMPONENTIZED_HOST_UPDATE="false"

usage() {
  cat <<'EOF'
Usage: bash wework/scripts/build-minio-windows-release.sh --version <version> [options]

Build the Electron Windows release used by GitHub CI and optionally publish
either the full app update or only its independently updatable components to
MinIO. Run this script on a native Windows host.

Options:
  --version <version>       Release version. Required.
  --channel <stable|beta>   Update channel. Default: stable.
  --release-kind <kind>     full or component. Default: full.
  --beta                    Shorthand for --channel beta.
  --notes <text>            Release notes.
  --endpoint <url>          S3 API endpoint.
  --bucket <name>           S3 bucket.
  --prefix <path>           Object prefix. Default: wework/windows.
  --output-dir <path>       Local artifact directory.
  --windows-build-target <target>
                            Only x86_64-pc-windows-msvc is supported.
  --brand-config <path>     Brand identity and internal runtime defaults.
                            Default: wework/branding/weibo.json.
  --unsigned                Build without Windows Authenticode signing.
  --upload                  Upload artifacts and rolling manifests.
  -h, --help                Show this help message.

Windows Authenticode signing environment unless --unsigned:
  WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
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

upload_artifacts() {
  require_env ATTACHMENT_S3_ACCESS_KEY
  require_env ATTACHMENT_S3_SECRET_KEY
  ATTACHMENT_S3_ENDPOINT="$S3_ENDPOINT" \
  ATTACHMENT_S3_BUCKET="$S3_BUCKET" \
  WEWORK_RELEASE_S3_PREFIX="$S3_PREFIX" \
  WEWORK_COMPONENT_S3_PREFIX="$COMPONENT_S3_PREFIX" \
  RELEASE_VERSION="$VERSION" \
  RELEASE_SOURCE_SHA="$SOURCE_SHA" \
  RELEASE_CHANNEL="$CHANNEL" \
  RELEASE_KIND="$RELEASE_KIND" \
  RELEASE_OUTPUT_DIR="$OUTPUT_DIR" \
    uv run --script "$SCRIPT_DIR/upload-windows-release-to-s3.py"
}

verify_uploaded_artifacts() {
  local electron_channel="$CHANNEL"
  local component_manifest="components-$CHANNEL-windows-x64.json"
  if ! curl -fsSI -o /dev/null "$UPDATE_BASE_URL/$component_manifest"; then
    echo "Published component manifest is not publicly readable: $UPDATE_BASE_URL/$component_manifest" >&2
    exit 1
  fi
  node "$SCRIPT_DIR/verify-minio-component-release.mjs" \
    "$UPDATE_BASE_URL" "$COMPONENT_BASE_URL" \
    "$VERSION" "$CHANNEL" windows x64
  if [ "$RELEASE_KIND" = "component" ]; then
    return
  fi
  [ "$CHANNEL" = "stable" ] && electron_channel="latest"
  for url in \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_windows-x64-setup.exe" \
    "$UPDATE_BASE_URL/WeWork_${VERSION}_windows-x64-setup.exe.blockmap" \
    "$UPDATE_BASE_URL/WeWorkHostUpdate_${VERSION}_windows-x64-setup.exe" \
    "$UPDATE_BASE_URL/WeWorkHostUpdate_${VERSION}_windows-x64-setup.exe.blockmap" \
    "$UPDATE_BASE_URL/$electron_channel.yml" \
    "$UPDATE_BASE_URL/$CHANNEL-windows-x86_64.json"; do
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
    --windows-build-target) WINDOWS_BUILD_TARGET="$2"; shift 2 ;;
    --brand-config) BRAND_CONFIG="$2"; shift 2 ;;
    --unsigned) UNSIGNED="true"; shift ;;
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
if [ "$CHANNEL" = "stable" ] && [[ "$VERSION" == *-beta.* ]]; then
  echo "A beta version must be published to the beta channel." >&2
  exit 1
fi
if [ "$WINDOWS_BUILD_TARGET" != "x86_64-pc-windows-msvc" ]; then
  echo "Only x86_64-pc-windows-msvc is supported." >&2
  exit 1
fi
if [ "$(node -p process.platform 2>/dev/null || true)" != "win32" ]; then
  echo "Windows Electron releases must be built on a native Windows host." >&2
  exit 1
fi
if [ ! -f "$BRAND_CONFIG" ]; then
  echo "Brand config not found: $BRAND_CONFIG" >&2
  exit 1
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
BRAND_CONFIG="$(cd "$(dirname "$BRAND_CONFIG")" && pwd)/$(basename "$BRAND_CONFIG")"
SOURCE_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
export WEWORK_BRAND_CONFIG="$BRAND_CONFIG"
export WEWORK_RELEASE_VERSION="$VERSION"
export WEWORK_SOURCE_SHA="$SOURCE_SHA"
UPDATE_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX"
COMPONENT_BASE_URL="$S3_ENDPOINT/$S3_BUCKET/$COMPONENT_S3_PREFIX"
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
require_command curl
COMPONENTIZED_HOST_UPDATE="$(
  wework_resolve_componentized_host_update \
    "$UPDATE_BASE_URL/components-$CHANNEL-windows-x64.json"
)"
if [ "$COMPONENTIZED_HOST_UPDATE" = "true" ]; then
  export WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS=false
else
  export WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS=true
fi
echo "Componentized Host update enabled: $COMPONENTIZED_HOST_UPDATE"
if [ "$UNSIGNED" = "true" ]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  unset WIN_CSC_LINK
  unset WIN_CSC_KEY_PASSWORD
  echo "Windows Authenticode signing is disabled."
else
  require_env WIN_CSC_LINK
fi

echo "Building Wework Electron Windows x64 release $VERSION ($CHANNEL)"
CARGO_BUILD_TARGET="$WINDOWS_BUILD_TARGET" \
WEWORK_RUNTIME_TARGET="$WINDOWS_BUILD_TARGET" \
WEWORK_CODEX_TARGET="$WINDOWS_BUILD_TARGET" \
WEWORK_DWS_TARGET="$WINDOWS_BUILD_TARGET" \
WEWORK_RELEASE_PLATFORM=windows \
WEWORK_RELEASE_ARCH=x64 \
WEWORK_SOURCE_SHA="$SOURCE_SHA" \
WEWORK_UPDATE_BASE_URL="$UPDATE_BASE_URL" \
VITE_WEWORK_RELEASE_CHANNEL="$CHANNEL" \
VITE_WEWORK_RUNTIME_MODE=local-first \
  pnpm --filter wework build:release

node "$SCRIPT_DIR/prepare-desktop-release-assets.mjs" \
  windows x64 "$VERSION" "$OUTPUT_DIR"
notes_path="$OUTPUT_DIR/WeWork_${VERSION}_windows-x64.md"
printf '%s\n' "$RELEASE_NOTES" > "$notes_path"
WEWORK_RELEASE_BASE_URL="$UPDATE_BASE_URL" \
WEWORK_COMPONENT_BASE_URL="$COMPONENT_BASE_URL" \
WEWORK_USE_COMPONENTIZED_HOST_UPDATE="$COMPONENTIZED_HOST_UPDATE" \
WEWORK_RELEASE_TARGETS=windows-x64 \
  node "$SCRIPT_DIR/generate-desktop-update-manifests.mjs" \
    "$OUTPUT_DIR" "$OUTPUT_DIR" "$VERSION" "$CHANNEL" \
    internal/minio "minio-$VERSION" "$notes_path" "$SOURCE_SHA"

if [ "$UPLOAD" = "true" ]; then
  upload_artifacts
  verify_uploaded_artifacts
  echo "Published MinIO $RELEASE_KIND release assets and component update channels."
else
  echo "Release artifacts are ready in: $OUTPUT_DIR"
fi
