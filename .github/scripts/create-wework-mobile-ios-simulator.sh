#!/usr/bin/env bash

set -euo pipefail

device_type="com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
runtime="$({
  xcrun simctl list runtimes --json
} | jq -r '
  [.runtimes[]
    | select(
        .platform == "iOS"
        and .isAvailable == true
        and (.version | startswith("26."))
      )
  ]
  | sort_by(.version | split(".") | map(tonumber))
  | last
  | .identifier
')"

if [[ -z "$runtime" || "$runtime" == "null" ]]; then
  echo "No available iOS 26 Simulator runtime was found" >&2
  exit 1
fi

if ! xcrun simctl list devicetypes --json \
  | jq -e --arg id "$device_type" '.devicetypes[] | select(.identifier == $id)' >/dev/null; then
  echo "Required iPhone 17 Pro Simulator device type is unavailable" >&2
  exit 1
fi

device_name="Wework-Mobile-E2E-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}"
device_id="$(xcrun simctl create "$device_name" "$device_type" "$runtime")"
xcrun simctl boot "$device_id"
xcrun simctl bootstatus "$device_id" -b

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'WEWORK_MOBILE_E2E_DEVICE=%s\n' "$device_id" >> "$GITHUB_ENV"
fi
printf '%s\n' "$device_id"
