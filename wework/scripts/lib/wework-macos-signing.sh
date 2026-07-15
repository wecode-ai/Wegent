#!/usr/bin/env bash

# Shared macOS code-signing helpers for Wework build scripts.

wework_resolve_developer_id_application_identity() {
  local identity="${1:-}"
  if [ -n "$identity" ]; then
    printf '%s\n' "$identity"
    return 0
  fi

  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' \
    | head -n 1
}

wework_sign_prepared_codex_macos_binaries() {
  local wework_dir="$1"
  local build_target="$2"
  local identity
  local skip_sign="${4:-0}"

  if [ "$skip_sign" = "1" ]; then
    return 0
  fi

  identity="$(wework_resolve_developer_id_application_identity "${3:-}")"
  if [ -z "$identity" ]; then
    echo "No valid Developer ID Application identity found for Codex binaries." >&2
    return 1
  fi
  export APPLE_SIGNING_IDENTITY="$identity"

  local targets=()
  case "$build_target" in
    universal-apple-darwin)
      targets=(aarch64-apple-darwin x86_64-apple-darwin)
      ;;
    aarch64-apple-darwin|x86_64-apple-darwin)
      targets=("$build_target")
      ;;
    "")
      if [ "$(uname -m)" = "arm64" ]; then
        targets=(aarch64-apple-darwin)
      else
        targets=(x86_64-apple-darwin)
      fi
      ;;
  esac

  local target target_root binary signature
  for target in "${targets[@]}"; do
    target_root="$wework_dir/src-tauri/binaries/codex/$target"
    [ -d "$target_root" ] || continue

    while IFS= read -r -d '' binary; do
      [[ "$(file -b "$binary")" == *Mach-O* ]] || continue
      signature="$(codesign --display --verbose=4 "$binary" 2>&1 || true)"
      if [[ "$signature" == *"Authority=Developer ID Application:"* ]] \
        && [[ "$signature" == *"Timestamp="* ]] \
        && [[ "$signature" == *"Runtime Version="* ]]; then
        continue
      fi

      echo "Signing bundled Codex executable: ${binary#"$wework_dir/"}"
      codesign --force --timestamp --options runtime --sign "$identity" "$binary"
    done < <(find "$target_root" -type f -print0)
  done
}
