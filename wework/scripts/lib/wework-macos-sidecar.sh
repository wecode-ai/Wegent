#!/usr/bin/env bash

wework_build_macos_executor_sidecar() {
  local project_dir="$1"
  local wework_dir="$2"
  local macos_build_target="$3"
  local build_profile="${4:-release}"
  local executor_dir="$project_dir/executor"
  local executor_target_dir="$executor_dir/target"
  local sidecar_dir="$wework_dir/src-tauri/binaries"
  local sidecar_target="$macos_build_target"
  local cargo_profile_dir="debug"
  local cargo_profile_args=()
  local cargo_targets=()

  if [ "$build_profile" = "release" ]; then
    cargo_profile_dir="release"
    cargo_profile_args=(--release)
  elif [ "$build_profile" != "dev" ]; then
    echo "Unsupported executor build profile: $build_profile" >&2
    return 1
  fi

  case "$macos_build_target" in
    universal-apple-darwin)
      cargo_targets=(aarch64-apple-darwin x86_64-apple-darwin)
      ;;
    aarch64-apple-darwin|x86_64-apple-darwin)
      cargo_targets=("$macos_build_target")
      ;;
    "")
      sidecar_target="$(rustc -vV | sed -n 's/^host: //p')"
      case "$sidecar_target" in
        aarch64-apple-darwin|x86_64-apple-darwin) ;;
        *)
          echo "Unsupported native macOS Rust target: ${sidecar_target:-<unknown>}" >&2
          return 1
          ;;
      esac
      cargo_targets=("$sidecar_target")
      ;;
    *)
      echo "Unsupported macOS executor target: $macos_build_target" >&2
      return 1
      ;;
  esac

  echo "Building bundled executor sidecar from current source"
  for cargo_target in "${cargo_targets[@]}"; do
    echo "  executor target: $cargo_target ($build_profile)"
    CARGO_TARGET_DIR="$executor_target_dir" cargo build \
      --manifest-path "$executor_dir/Cargo.toml" \
      --locked \
      --bin wegent-executor \
      "${cargo_profile_args[@]}" \
      --target "$cargo_target"
  done

  mkdir -p "$sidecar_dir"
  local sidecar_path="$sidecar_dir/wegent-executor-$sidecar_target"
  local build_output_path=""
  if [ "$sidecar_target" = "universal-apple-darwin" ]; then
    lipo -create \
      "$executor_target_dir/aarch64-apple-darwin/$cargo_profile_dir/wegent-executor" \
      "$executor_target_dir/x86_64-apple-darwin/$cargo_profile_dir/wegent-executor" \
      -output "$sidecar_path"
    build_output_path="$sidecar_path"
  else
    build_output_path="$executor_target_dir/$sidecar_target/$cargo_profile_dir/wegent-executor"
    cp -f \
      "$build_output_path" \
      "$sidecar_path"
  fi
  chmod 0755 "$sidecar_path"

  "$sidecar_path" --version
  export WEWORK_EXECUTOR_SIDECAR="$build_output_path"
  echo "Bundled executor sidecar ready: $sidecar_path"
  echo "Tauri executor sidecar source: $WEWORK_EXECUTOR_SIDECAR"
}

wework_verify_macos_app_executor_sidecar() {
  local bundle_root="$1"
  local bundled_executor=""

  if [ -d "$bundle_root/macos" ]; then
    bundled_executor="$(find "$bundle_root/macos" -type f \
      -path '*/Contents/MacOS/wegent-executor' -print | sort | tail -1)"
  fi
  if [ -z "$bundled_executor" ]; then
    echo "Bundled macOS app executor was not found under: $bundle_root/macos" >&2
    return 1
  fi

  "$bundled_executor" --version
  echo "Verified bundled app executor sidecar: $bundled_executor"
}
