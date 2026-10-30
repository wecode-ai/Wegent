#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mobile_dir="$repo_root/wework-mobile"
artifact_dir="$mobile_dir/artifacts/android-e2e"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:?Android SDK is required}}"
serial=emulator-5556
image='system-images;android-36;google_apis;x86_64'
mkdir -p "$artifact_dir"

export EXPO_PUBLIC_BACKEND_URL=http://localhost:8000
export EXPO_PUBLIC_WEWORK_APP_LINK_HOST=mobile.e2e.invalid
export WEWORK_APP_LINK_HOST=mobile.e2e.invalid
export ORG_GRADLE_PROJECT_reactNativeArchitectures=x86_64
export CI=true

cleanup() {
  local result=$?
  if [[ "${gradle_started:-false}" == true ]]; then
    (cd "$mobile_dir/android" && ./gradlew --stop) >/dev/null 2>&1 || true
  fi
  if [[ -n "${metro_pid:-}" ]]; then
    kill -- "-$metro_pid" 2>/dev/null || true
    wait "$metro_pid" 2>/dev/null || true
  fi
  if [[ -n "${emulator_pid:-}" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  for report in test-results playwright-report blob-report; do
    if [[ -d "$repo_root/frontend/$report" ]]; then
      cp -R "$repo_root/frontend/$report" "$artifact_dir/$report"
    fi
  done
  exit "$result"
}
trap cleanup EXIT

sdkmanager "$image" 'platform-tools' 'emulator'
printf 'no\n' | avdmanager create avd --force --name wework-mobile-e2e --package "$image"
"$sdk_root/emulator/emulator" -avd wework-mobile-e2e -port 5556 \
  -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
  -memory 1536 -cores 2 \
  > "$artifact_dir/emulator.log" 2>&1 &
emulator_pid=$!
if ! timeout --kill-after=5s 180s adb -s "$serial" wait-for-device; then
  printf 'Android emulator did not connect to ADB within 180 seconds\n' >&2
  exit 1
fi
booted=false
for ((attempt = 0; attempt < 180; attempt++)); do
  if [[ "$(adb -s "$serial" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; then
    booted=true
    break
  fi
  sleep 1
done
[[ "$booted" == true ]] || { printf 'Android emulator did not boot\n' >&2; exit 1; }
if ! adb -s "$serial" shell pm path com.android.chrome | rg -q '^package:'; then
  printf 'The Android E2E system image must include Chrome for the real authorization flow\n' >&2
  exit 1
fi
adb -s "$serial" shell input keyevent 82
for port in 3000 8000 8081; do adb -s "$serial" reverse "tcp:$port" "tcp:$port"; done

setsid pnpm --dir "$mobile_dir" exec expo start --localhost --port 8081 --max-workers 1 \
  > "$artifact_dir/metro.log" 2>&1 &
metro_pid=$!
metro_ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl --fail --silent http://localhost:8081/status | rg -q 'packager-status:running'; then
    metro_ready=true
    break
  fi
  sleep 1
done
[[ "$metro_ready" == true ]] || { printf 'Metro did not start\n' >&2; exit 1; }
gradle_started=true
(
  cd "$mobile_dir/android"
  ./gradlew :app:assembleDebug --no-daemon --max-workers=1 \
    -Dorg.gradle.parallel=false -PreactNativeArchitectures=x86_64
)
adb -s "$serial" install -r "$mobile_dir/android/app/build/outputs/apk/debug/app-debug.apk"
pnpm --dir "$repo_root/frontend" exec playwright install --with-deps chromium
pnpm --dir "$mobile_dir" e2e:android
