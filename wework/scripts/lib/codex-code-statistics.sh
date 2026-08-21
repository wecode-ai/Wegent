#!/usr/bin/env bash

wework_code_statistics_targets() {
  case "$1" in
    aarch64-apple-darwin|x86_64-apple-darwin)
      printf '%s\n' "$1"
      ;;
    universal-apple-darwin|"")
      printf '%s\n' aarch64-apple-darwin x86_64-apple-darwin
      ;;
    *)
      echo "Unsupported code statistics Hook target: $1" >&2
      return 1
      ;;
  esac
}

wework_code_statistics_platform() {
  case "$1" in
    aarch64-apple-darwin) printf 'macos-aarch64\n' ;;
    x86_64-apple-darwin) printf 'macos-x86_64\n' ;;
    *) return 1 ;;
  esac
}

wework_code_statistics_macos_resources() {
  local macos_target="$1"
  local rust_target platform

  printf '%s\n' \
    "bundled-hooks/codex-code-statistics/hooks.json" \
    "bundled-hooks/codex-code-statistics/plugin.json"
  while IFS= read -r rust_target; do
    platform="$(wework_code_statistics_platform "$rust_target")"
    printf 'bundled-hooks/codex-code-statistics/bin/%s/**/*\n' "$platform"
  done < <(wework_code_statistics_targets "$macos_target")
}

wework_build_code_statistics_hook() {
  local wework_dir="$1"
  local macos_target="$2"
  local bundle_bin_dir="$wework_dir/src-tauri/bundled-hooks/codex-code-statistics/bin"
  local rust_target

  rm -rf "$bundle_bin_dir/macos-aarch64" "$bundle_bin_dir/macos-x86_64"
  while IFS= read -r rust_target; do
    "$wework_dir/src-tauri/hook-plugins/codex-code-statistics/build-target.sh" \
      "$rust_target"
  done < <(wework_code_statistics_targets "$macos_target")
}

wework_sign_code_statistics_hook() {
  local wework_dir="$1"
  local macos_target="$2"
  local identity="$3"
  local rust_target platform binary

  [ -n "$identity" ] || return 0
  while IFS= read -r rust_target; do
    platform="$(wework_code_statistics_platform "$rust_target")"
    binary="$wework_dir/src-tauri/bundled-hooks/codex-code-statistics/bin/$platform/codex-code-statistics"
    codesign --force --options runtime --timestamp --sign "$identity" "$binary"
  done < <(wework_code_statistics_targets "$macos_target")
}

wework_verify_code_statistics_hook() {
  local bundle_root="$1"
  local macos_target="$2"
  local rust_target platform

  while IFS= read -r rust_target; do
    platform="$(wework_code_statistics_platform "$rust_target")"
    if ! find "$bundle_root" -type f \
      -path "*/Contents/Resources/bundled-hooks/codex-code-statistics/bin/$platform/codex-code-statistics" \
      -perm -111 -print -quit | grep -q .; then
      echo "Packaged code statistics Hook is missing for $platform" >&2
      return 1
    fi
  done < <(wework_code_statistics_targets "$macos_target")

  if [ "$macos_target" = "aarch64-apple-darwin" ]; then
    platform="macos-x86_64"
  elif [ "$macos_target" = "x86_64-apple-darwin" ]; then
    platform="macos-aarch64"
  else
    return 0
  fi
  if find "$bundle_root" -type f \
    -path "*/Contents/Resources/bundled-hooks/codex-code-statistics/bin/$platform/codex-code-statistics" \
    -print -quit | grep -q .; then
    echo "Packaged code statistics Hook unexpectedly includes $platform" >&2
    return 1
  fi
}

wework_build_windows_code_statistics_hook() {
  local wework_dir="$1"
  local windows_target="$2"
  local plugin_dir="$wework_dir/src-tauri/hook-plugins/codex-code-statistics"
  local platform destination binary

  case "$windows_target" in
    x86_64-pc-windows-msvc) platform="windows-x86_64" ;;
    aarch64-pc-windows-msvc) platform="windows-aarch64" ;;
    *)
      echo "Unsupported Windows code statistics Hook target: $windows_target" >&2
      return 1
      ;;
  esac

  cargo xwin build \
    --manifest-path "$plugin_dir/Cargo.toml" \
    --target-dir "$plugin_dir/target" \
    --release \
    --locked \
    --target "$windows_target"
  binary="$plugin_dir/target/$windows_target/release/codex-code-statistics.exe"
  destination="$wework_dir/src-tauri/bundled-hooks/codex-code-statistics/bin/$platform"
  mkdir -p "$destination"
  cp "$binary" "$destination/codex-code-statistics.exe"
}

wework_verify_windows_code_statistics_hook() {
  local installer_script="$1"
  local windows_target="$2"
  local platform

  case "$windows_target" in
    x86_64-pc-windows-msvc) platform="windows-x86_64" ;;
    aarch64-pc-windows-msvc) platform="windows-aarch64" ;;
    *) return 1 ;;
  esac
  if ! grep -F \
    "bundled-hooks\\codex-code-statistics\\bin\\$platform\\codex-code-statistics.exe" \
    "$installer_script" >/dev/null; then
    echo "NSIS installer is missing the code statistics Hook for $platform" >&2
    return 1
  fi
}
