#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib/wework-mac-env.sh
source "$SCRIPT_DIR/lib/wework-mac-env.sh"
# shellcheck source=lib/wework-macos-signing.sh
source "$SCRIPT_DIR/lib/wework-macos-signing.sh"

TARGET="local"
VERSION_OVERRIDE=""
RELEASE_NOTES="${RELEASE_NOTES:-New Wework release.}"
LOCAL_PROJECT_DIR="${LOCAL_PROJECT_DIR:-$WEWORK_DIR/src-tauri/target/release/local-update-server}"
LOCAL_DIST_DIR="${LOCAL_DIST_DIR:-$LOCAL_PROJECT_DIR/dist/wework}"
LOCAL_DOWNLOAD_BASE_URL="${LOCAL_DOWNLOAD_BASE_URL:-http://127.0.0.1:8787/dist/wework}"
PROD_UPDATE_BASE_URL="${WEWORK_UPDATE_BASE_URL:-}"
SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/wework-updater.key}"
UPDATER_PUBKEY="${TAURI_UPDATER_PUBKEY:-}"
NOTARY_PROFILE="${MACOS_NOTARY_PROFILE:-}"
APPLE_BUILD_ID="${APPLE_BUILD_ID:-}"
APPLE_BUILD_TEAM_ID="${APPLE_BUILD_TEAM_ID:-}"
APPLE_BUILD_PASSWORD="${APPLE_BUILD_PASSWORD:-}"
DEFAULT_NOTARY_PROFILE="${DEFAULT_NOTARY_PROFILE:-wework-notary}"
MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-universal-apple-darwin}"
PRINT_NEXT_VERSION_ONLY="false"
RELEASE_DEVTOOLS="${WEWORK_RELEASE_DEVTOOLS:-}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --target <local|prod>      Release target. Default: local.
  --version <version>        Override the auto-incremented version.
  --notes <text>             Release notes. Default: "New Wework release."
  --local-project-dir <path> Local static server root. Default: <repo>/src-tauri/target/release/local-update-server
  --local-dist-dir <path>    Local dist dir. Default: <local-project-dir>/dist/wework
  --local-base-url <url>     Local download base URL.
  --update-base-url <url>    Production update service base URL. Overrides WEWORK_UPDATE_BASE_URL.
  --signing-key-path <path>  Tauri updater private key path.
  --notary-profile <name>    Keychain profile name used by xcrun notarytool.
  --macos-build-target <target>
                              macOS Rust/Tauri target. Default: universal-apple-darwin.
  --devtools                  Enable Web Inspector support in the release build.
  --print-next-version       Only print the next version and exit.
  -h, --help                 Show this help message.

Environment overrides:
  RELEASE_NOTES, LOCAL_PROJECT_DIR, LOCAL_DIST_DIR, LOCAL_DOWNLOAD_BASE_URL,
  WEWORK_UPDATE_BASE_URL, WEWORK_UPDATE_PUBLISH_TOKEN, TAURI_SIGNING_PRIVATE_KEY,
  TAURI_SIGNING_PRIVATE_KEY_PATH, TAURI_SIGNING_PRIVATE_KEY_PASSWORD, TAURI_UPDATER_PUBKEY,
  MACOS_APP_SIGN_IDENTITY, MACOS_KEYCHAIN_PATH, MACOS_NOTARY_PROFILE,
  APPLE_BUILD_ID, APPLE_BUILD_TEAM_ID, APPLE_BUILD_PASSWORD, DEFAULT_NOTARY_PROFILE,
  MACOS_BUILD_TARGET, WEWORK_RELEASE_DEVTOOLS, VITE_WEGENT_BACKEND_URL,
  VITE_WEGENT_SOCKET_URL
EOF
}

log_signing() {
  printf '[signing] %s\n' "$*"
}

find_identity_name() {
  local policy="$1"
  local pattern="$2"

  if [ -n "${MACOS_KEYCHAIN_PATH:-}" ]; then
    security find-identity -v -p "$policy" "$MACOS_KEYCHAIN_PATH" 2>/dev/null \
      | sed -n 's/.*"\(.*\)"/\1/p' \
      | grep -F "$pattern" \
      | head -n 1
    return 0
  fi

  security find-identity -v -p "$policy" 2>/dev/null \
    | sed -n 's/.*"\(.*\)"/\1/p' \
    | grep -F "$pattern" \
    | head -n 1
}

resolve_app_sign_identity() {
  local identity

  if [ -n "${MACOS_APP_SIGN_IDENTITY:-}" ]; then
    printf '%s\n' "$MACOS_APP_SIGN_IDENTITY"
    return 0
  fi

  identity="$(find_identity_name codesigning "Developer ID Application:" || true)"
  if [ -n "$identity" ]; then
    printf '%s\n' "$identity"
    return 0
  fi

  find_identity_name basic "Developer ID Application:"
}

require_signing_identity_for_prod() {
  local identity="$1"

  if [ "$TARGET" = "prod" ] && [ -z "$identity" ]; then
    echo "Production release requires a Developer ID Application certificate." >&2
    echo "Set MACOS_APP_SIGN_IDENTITY or import the p12 certificate into your keychain." >&2
    exit 1
  fi
}

require_notary_profile_for_prod() {
  if [ "$TARGET" = "prod" ] && [ -z "$NOTARY_PROFILE" ] && [ -z "$APPLE_BUILD_ID" ]; then
    echo "Production release requires notarization." >&2
    echo "Set MACOS_NOTARY_PROFILE or APPLE_BUILD_ID/APPLE_BUILD_TEAM_ID/APPLE_BUILD_PASSWORD." >&2
    exit 1
  fi
}

ensure_notary_profile() {
  if [ -z "$NOTARY_PROFILE" ]; then
    if [ -n "$APPLE_BUILD_ID" ] || [ -n "$APPLE_BUILD_TEAM_ID" ] || [ -n "$APPLE_BUILD_PASSWORD" ]; then
      if [ -z "$APPLE_BUILD_ID" ] || [ -z "$APPLE_BUILD_TEAM_ID" ] || [ -z "$APPLE_BUILD_PASSWORD" ]; then
        echo "APPLE_BUILD_ID, APPLE_BUILD_TEAM_ID, and APPLE_BUILD_PASSWORD must all be set for notarization." >&2
        exit 1
      fi
      NOTARY_PROFILE="$DEFAULT_NOTARY_PROFILE"
    else
      return 0
    fi
  fi

  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    return 0
  fi

  if [ -z "$APPLE_BUILD_ID" ] || [ -z "$APPLE_BUILD_TEAM_ID" ] || [ -z "$APPLE_BUILD_PASSWORD" ]; then
    echo "Notary profile '$NOTARY_PROFILE' is not usable. Configure it with xcrun notarytool store-credentials or set APPLE_BUILD_*." >&2
    exit 1
  fi

  log_signing "Configuring notary profile: $NOTARY_PROFILE"
  xcrun notarytool store-credentials "$NOTARY_PROFILE" \
    --apple-id "$APPLE_BUILD_ID" \
    --team-id "$APPLE_BUILD_TEAM_ID" \
    --password "$APPLE_BUILD_PASSWORD" >/dev/null
}

verify_notary_profile() {
  if [ -z "$NOTARY_PROFILE" ]; then
    return 0
  fi

  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "Notary profile '$NOTARY_PROFILE' is not usable. Configure it with xcrun notarytool store-credentials first." >&2
    exit 1
  fi
}

maybe_sign_dmg() {
  local dmg_path="$1"
  local identity="$2"

  if [ -z "$identity" ]; then
    log_signing "No Developer ID Application identity found. Leaving DMG unsigned."
    return 0
  fi

  log_signing "Signing DMG with: $identity"
  if [ -n "${MACOS_KEYCHAIN_PATH:-}" ]; then
    codesign --force --timestamp --keychain "$MACOS_KEYCHAIN_PATH" --sign "$identity" "$dmg_path"
  else
    codesign --force --timestamp --sign "$identity" "$dmg_path"
  fi
}

maybe_notarize_and_staple() {
  local artifact_path="$1"

  if [ -z "$NOTARY_PROFILE" ]; then
    log_signing "MACOS_NOTARY_PROFILE not set. Skipping notarization for $(basename "$artifact_path")."
    return 0
  fi

  log_signing "Submitting for notarization with profile: $NOTARY_PROFILE"
  xcrun notarytool submit "$artifact_path" --keychain-profile "$NOTARY_PROFILE" --wait

  log_signing "Stapling ticket to $(basename "$artifact_path")"
  xcrun stapler staple "$artifact_path"
}

next_patch_version_from_text() {
  VERSION_TEXT="$1" python3 - <<'PY'
import os
import re
import sys

version_text = os.environ["VERSION_TEXT"]
matches = re.findall(r'"version"\s*:\s*"v?(\d+\.\d+\.\d+)"', version_text)
if matches:
    tuples = [tuple(int(x) for x in version.split(".")) for version in matches]
    major, minor, patch = max(tuples)
    print(f"{major}.{minor}.{patch + 1}")
    sys.exit(0)

print("0.1.0")
PY
}

determine_next_version() {
  if [ -n "$VERSION_OVERRIDE" ]; then
    printf '%s\n' "$VERSION_OVERRIDE"
    return
  fi

  if [ "$TARGET" = "local" ] && [ -f "$LOCAL_DIST_DIR/latest.json" ]; then
    next_patch_version_from_text "$(cat "$LOCAL_DIST_DIR/latest.json")"
    return
  fi

  if [ "$TARGET" = "prod" ]; then
    local remote_latest
    if remote_latest="$(curl -fsSL "${PROD_UPDATE_BASE_URL%/}/latest.json" 2>/dev/null)"; then
      next_patch_version_from_text "$remote_latest"
      return
    fi
  fi

  printf '0.1.0\n'
}

platform_key() {
  case "$(uname -m)" in
    arm64)
      printf 'darwin-aarch64\n'
      ;;
    x86_64)
      printf 'darwin-x86_64\n'
      ;;
    *)
      echo "Unsupported macOS architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

updater_platforms() {
  case "$MACOS_BUILD_TARGET" in
    universal-apple-darwin)
      printf 'darwin-aarch64,darwin-x86_64\n'
      ;;
    aarch64-apple-darwin)
      printf 'darwin-aarch64\n'
      ;;
    x86_64-apple-darwin)
      printf 'darwin-x86_64\n'
      ;;
    "")
      platform_key
      ;;
    *)
      echo "Unsupported macOS build target for updater release: $MACOS_BUILD_TARGET" >&2
      echo "Use universal-apple-darwin, aarch64-apple-darwin, or x86_64-apple-darwin." >&2
      exit 1
      ;;
  esac
}

artifact_platform_suffix() {
  case "$MACOS_BUILD_TARGET" in
    universal-apple-darwin)
      printf 'universal\n'
      ;;
    *)
      updater_platforms | tr ',' '-'
      ;;
  esac
}

bundle_root() {
  if [ -n "$MACOS_BUILD_TARGET" ]; then
    printf '%s\n' "$WEWORK_DIR/src-tauri/target/$MACOS_BUILD_TARGET/release/bundle"
    return
  fi

  printf '%s\n' "$WEWORK_DIR/src-tauri/target/release/bundle"
}

require_macos_build_target() {
  if [ "$MACOS_BUILD_TARGET" != "universal-apple-darwin" ]; then
    return
  fi

  local missing_targets=()
  for target in aarch64-apple-darwin x86_64-apple-darwin; do
    if ! rustup target list --installed | grep -Fxq "$target"; then
      missing_targets+=("$target")
    fi
  done

  if [ "${#missing_targets[@]}" -gt 0 ]; then
    echo "Missing Rust target(s) required for universal macOS release: ${missing_targets[*]}" >&2
    echo "Install them with: rustup target add ${missing_targets[*]}" >&2
    exit 1
  fi
}

find_update_archive() {
  find "$(bundle_root)" -type f \
    -name "*.app.tar.gz" \
    -print | sort | tail -1
}

find_dmg() {
  find "$(bundle_root)" -type f \
    -name "*.dmg" \
    -print | sort | tail -1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    echo "Set it before running this script, for example: export $name=..." >&2
    exit 1
  fi
}

publish_to_update_service() {
  local version="$1"
  local platforms="$2"
  local notes="$3"
  local archive_file="$4"
  local signature_value="$5"
  local dmg_file="$6"

  require_env WEWORK_UPDATE_PUBLISH_TOKEN

  local curl_args=(
    -fsS
    -X POST
    -H "Authorization: Bearer ${WEWORK_UPDATE_PUBLISH_TOKEN}"
    -F "version=${version}"
    -F "platforms=${platforms}"
    -F "notes=${notes}"
    -F "signature=${signature_value}"
    -F "archive=@${archive_file}"
  )
  if [ -n "$dmg_file" ] && [ -f "$dmg_file" ]; then
    curl_args+=(-F "dmg=@${dmg_file}")
  fi

  curl "${curl_args[@]}" "${PROD_UPDATE_BASE_URL%/}/releases"
  printf '\n'
}

prod_download_base_url() {
  local base="${PROD_UPDATE_BASE_URL%/}"
  printf '%s\n' "${base%/update}"
}

write_latest_json() {
  local output_path="$1"
  local version="$2"
  local notes="$3"
  local download_url="$4"
  local signature="$5"
  local target_keys="$6"

  VERSION="$version" \
  RELEASE_NOTES_VALUE="$notes" \
  DOWNLOAD_URL="$download_url" \
  SIGNATURE="$signature" \
  TARGET_KEYS="$target_keys" \
  OUTPUT_PATH="$output_path" \
  python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

data = {
    "version": os.environ["VERSION"],
    "notes": os.environ["RELEASE_NOTES_VALUE"],
    "pub_date": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "platforms": {
        target_key: {
            "signature": os.environ["SIGNATURE"],
            "url": os.environ["DOWNLOAD_URL"],
        }
        for target_key in [value.strip() for value in os.environ["TARGET_KEYS"].split(",")]
        if target_key
    },
}

with open(os.environ["OUTPUT_PATH"], "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --version)
      VERSION_OVERRIDE="$2"
      shift 2
      ;;
    --notes)
      RELEASE_NOTES="$2"
      shift 2
      ;;
    --local-project-dir)
      LOCAL_PROJECT_DIR="$2"
      LOCAL_DIST_DIR="$LOCAL_PROJECT_DIR/dist/wework"
      shift 2
      ;;
    --local-dist-dir)
      LOCAL_DIST_DIR="$2"
      shift 2
      ;;
    --local-base-url)
      LOCAL_DOWNLOAD_BASE_URL="$2"
      shift 2
      ;;
    --update-base-url|--download-base-url)
      PROD_UPDATE_BASE_URL="$2"
      shift 2
      ;;
    --signing-key-path)
      SIGNING_PRIVATE_KEY_PATH="$2"
      shift 2
      ;;
    --notary-profile)
      NOTARY_PROFILE="$2"
      shift 2
      ;;
    --macos-build-target)
      MACOS_BUILD_TARGET="$2"
      shift 2
      ;;
    --devtools)
      RELEASE_DEVTOOLS="1"
      shift
      ;;
    --print-next-version)
      PRINT_NEXT_VERSION_ONLY="true"
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

if [ "$TARGET" != "local" ] && [ "$TARGET" != "prod" ]; then
  echo "--target must be 'local' or 'prod'" >&2
  exit 1
fi

if [ "$TARGET" = "prod" ] && [ -z "$PROD_UPDATE_BASE_URL" ]; then
  echo "Missing required environment variable: WEWORK_UPDATE_BASE_URL" >&2
  echo "Set it before publishing, for example:" >&2
  echo "  export WEWORK_UPDATE_BASE_URL=https://example.com/wework/update" >&2
  exit 1
fi

next_version="$(determine_next_version)"
if [ "$PRINT_NEXT_VERSION_ONLY" = "true" ]; then
  printf '%s\n' "$next_version"
  exit 0
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ ! -f "$SIGNING_PRIVATE_KEY_PATH" ]; then
    echo "Tauri updater signing key not found: $SIGNING_PRIVATE_KEY_PATH" >&2
    echo "Generate one with: pnpm --filter wework tauri signer generate -w $SIGNING_PRIVATE_KEY_PATH --ci" >&2
    exit 1
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING_PRIVATE_KEY_PATH")"
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

if [ -z "$UPDATER_PUBKEY" ]; then
  echo "Missing required environment variable: TAURI_UPDATER_PUBKEY" >&2
  echo "Set it to the public key that matches TAURI_SIGNING_PRIVATE_KEY." >&2
  exit 1
fi

app_sign_identity="$(resolve_app_sign_identity || true)"
require_signing_identity_for_prod "$app_sign_identity"
require_notary_profile_for_prod
ensure_notary_profile
verify_notary_profile
require_macos_build_target

BACKEND_PORT="${BACKEND_PORT:-9100}"
BACKEND_BASE_URL="$(wework_resolve_backend_base_url)"

export VITE_WEGENT_BACKEND_URL="${VITE_WEGENT_BACKEND_URL:-$BACKEND_BASE_URL}"

download_base_url="$LOCAL_DOWNLOAD_BASE_URL"
dist_dir="$LOCAL_DIST_DIR"
if [ "$TARGET" = "prod" ]; then
  download_base_url="$PROD_UPDATE_BASE_URL"
  dist_dir="$WEWORK_DIR/src-tauri/target/release/wework-release-prod"
  rm -rf "$dist_dir"
fi
mkdir -p "$dist_dir"

config_override="$(mktemp "$WEWORK_DIR/src-tauri/tauri.release.XXXXXX.json")"
cleanup() {
  rm -f "$config_override"
}
trap cleanup EXIT

VERSION="$next_version" \
UPDATER_ENDPOINT="${download_base_url%/}/latest.json" \
UPDATER_PUBKEY="$UPDATER_PUBKEY" \
SIGNING_IDENTITY="$app_sign_identity" \
RELEASE_DEVTOOLS="$RELEASE_DEVTOOLS" \
BASE_TAURI_CONFIG="$WEWORK_DIR/src-tauri/tauri.conf.json" \
ENABLE_INSECURE_TRANSPORT="$([ "$TARGET" = "local" ] && printf 'true' || printf 'false')" \
CONFIG_OVERRIDE="$config_override" \
python3 - <<'PY'
import json
import os

config = {
    "version": os.environ["VERSION"],
    "bundle": {
        "createUpdaterArtifacts": True,
    },
    "plugins": {
        "updater": {
            "endpoints": [os.environ["UPDATER_ENDPOINT"]],
            "pubkey": os.environ["UPDATER_PUBKEY"],
        },
    },
}

identity = os.environ["SIGNING_IDENTITY"].strip()
if identity:
    config["bundle"]["macOS"] = {
        "signingIdentity": identity,
        "hardenedRuntime": True,
    }

if os.environ["ENABLE_INSECURE_TRANSPORT"] == "true":
    config["plugins"]["updater"]["dangerousInsecureTransportProtocol"] = True

if os.environ["RELEASE_DEVTOOLS"] == "1":
    with open(os.environ["BASE_TAURI_CONFIG"], "r", encoding="utf-8") as handle:
        base_config = json.load(handle)
    config["app"] = {
        "windows": [
            {
                **window,
                "devtools": True,
            }
            for window in base_config.get("app", {}).get("windows", [])
        ],
    }

with open(os.environ["CONFIG_OVERRIDE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY

echo "Release target: $TARGET"
echo "Releasing version: $next_version"
echo "macOS build target: $MACOS_BUILD_TARGET"
echo "Updater platforms: $(updater_platforms)"
echo "Release devtools: ${RELEASE_DEVTOOLS:-0}"
if [ -n "$app_sign_identity" ]; then
  echo "Signing identity: $app_sign_identity"
elif [ "$TARGET" = "local" ]; then
  echo "Signing identity: not found (local release will be unsigned)"
fi
if [ -n "$NOTARY_PROFILE" ]; then
  echo "Notary profile: $NOTARY_PROFILE"
elif [ "$TARGET" = "local" ]; then
  echo "Notary profile: not set (local release will skip notarization)"
fi
echo "VITE_WEGENT_BACKEND_URL=$VITE_WEGENT_BACKEND_URL"
echo "VITE_WEGENT_SOCKET_URL=${VITE_WEGENT_SOCKET_URL:-<backend URL>}"

cd "$WEWORK_DIR"
rm -rf "$(bundle_root)"
TAURI_BUILD_ARGS=(build)
if [ -n "$MACOS_BUILD_TARGET" ]; then
  TAURI_BUILD_ARGS+=(--target "$MACOS_BUILD_TARGET")
fi
if [ "$RELEASE_DEVTOOLS" = "1" ]; then
  TAURI_BUILD_ARGS+=(--features release-devtools)
fi
TAURI_BUILD_ARGS+=(--config "$config_override")
WEWORK_CODEX_TARGET="${MACOS_BUILD_TARGET:-}" pnpm run prepare:codex
if [ -n "$app_sign_identity" ]; then
  wework_sign_prepared_codex_macos_binaries \
    "$WEWORK_DIR" \
    "$MACOS_BUILD_TARGET" \
    "$app_sign_identity"
fi
pnpm exec tauri "${TAURI_BUILD_ARGS[@]}"

archive_path="$(find_update_archive)"
if [ -z "$archive_path" ] || [ ! -f "$archive_path" ]; then
  echo "Updater archive was not found for version $next_version" >&2
  exit 1
fi

signature_path="$archive_path.sig"
if [ ! -f "$signature_path" ]; then
  echo "Updater signature was not found: $signature_path" >&2
  exit 1
fi

dmg_path="$(find_dmg)"
if [ -n "$dmg_path" ] && [ -f "$dmg_path" ]; then
  maybe_sign_dmg "$dmg_path" "$app_sign_identity"
  maybe_notarize_and_staple "$dmg_path"
fi

artifact_suffix="$(artifact_platform_suffix)"
archive_name="WeWork_${next_version}_${artifact_suffix}.app.tar.gz"
signature="$(cat "$signature_path")"
cp -f "$archive_path" "$dist_dir/$archive_name"
cp -f "$signature_path" "$dist_dir/$archive_name.sig"
dmg_name=""
if [ -n "$dmg_path" ] && [ -f "$dmg_path" ]; then
  dmg_name="WeWork_${next_version}_${artifact_suffix}.dmg"
  cp -f "$dmg_path" "$dist_dir/$dmg_name"
fi
printf '%s\n' "$RELEASE_NOTES" > "$dist_dir/${archive_name%.app.tar.gz}.md"
archive_download_url="${download_base_url%/}/$archive_name"
if [ "$TARGET" = "prod" ]; then
  archive_download_url="${download_base_url%/}/releases/${next_version}/$archive_name"
fi
write_latest_json \
  "$dist_dir/latest.json" \
  "$next_version" \
  "$RELEASE_NOTES" \
  "$archive_download_url" \
  "$signature" \
  "$(updater_platforms)"

if [ "$TARGET" = "prod" ]; then
  publish_to_update_service \
    "$next_version" \
    "$(updater_platforms)" \
    "$RELEASE_NOTES" \
    "$dist_dir/$archive_name" \
    "$signature" \
    "${dmg_name:+$dist_dir/$dmg_name}"
  echo "Published updater manifest: ${PROD_UPDATE_BASE_URL%/}/latest.json"
  echo "Published latest DMG: $(prod_download_base_url)/WeWork.dmg"
else
  echo "Published updater archive: $dist_dir/$archive_name"
  echo "Published updater manifest: $dist_dir/latest.json"
fi
