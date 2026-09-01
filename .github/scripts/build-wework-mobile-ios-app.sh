#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <simulator-udid> <absolute-output-app-path>" >&2
  exit 1
fi

device_id="$1"
output_app="$2"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mobile_dir="$repository_root/wework-mobile"

case "$output_app" in
  /*.app) ;;
  *)
    echo "Output application path must be absolute and end with .app: $output_app" >&2
    exit 1
    ;;
esac

xcrun simctl bootstatus "$device_id" -b

created_derived_data=false
if [[ -n "${WEWORK_MOBILE_IOS_DERIVED_DATA:-}" ]]; then
  derived_data="$WEWORK_MOBILE_IOS_DERIVED_DATA"
  mkdir -p "$derived_data"
else
  derived_data="$(mktemp -d "${TMPDIR:-/tmp}/wegent-mobile-ios-e2e.XXXXXX")"
  created_derived_data=true
fi

cleanup() {
  if [[ "$created_derived_data" == "true" ]]; then
    rm -rf "$derived_data"
  fi
}
trap cleanup EXIT

(
  cd "$mobile_dir"
  pod install --deployment --project-directory=ios
  xcodebuild \
    -quiet \
    -workspace ios/Wegent.xcworkspace \
    -scheme Wegent \
    -configuration Release \
    -sdk iphonesimulator \
    -destination "id=$device_id" \
    -derivedDataPath "$derived_data" \
    ONLY_ACTIVE_ARCH=YES \
    "ARCHS=$(uname -m)" \
    build
)

built_app="$derived_data/Build/Products/Release-iphonesimulator/Wegent.app"
if [[ ! -d "$built_app" ]]; then
  echo "xcodebuild did not produce the expected application: $built_app" >&2
  exit 1
fi

mkdir -p "$(dirname "$output_app")"
if [[ -e "$output_app" ]]; then
  rm -rf "$output_app"
fi
ditto "$built_app" "$output_app"
