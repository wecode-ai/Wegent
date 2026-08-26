#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <rust-target>" >&2
  exit 2
fi

rust_target=$1
case "$rust_target" in
  aarch64-apple-darwin) plugin_target=macos-aarch64 ;;
  x86_64-apple-darwin) plugin_target=macos-x86_64 ;;
  aarch64-unknown-linux-gnu) plugin_target=linux-aarch64 ;;
  x86_64-unknown-linux-gnu) plugin_target=linux-x86_64 ;;
  aarch64-pc-windows-msvc) plugin_target=windows-aarch64 ;;
  x86_64-pc-windows-msvc) plugin_target=windows-x86_64 ;;
  *) echo "unsupported Rust target: $rust_target" >&2; exit 2 ;;
esac

plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bundle_dir="$plugin_dir/../../bundled-hooks/codex-code-statistics"
cargo build --manifest-path "$plugin_dir/Cargo.toml" --target-dir "$plugin_dir/target" --release --locked --target "$rust_target"
destination="$bundle_dir/bin/$plugin_target"
mkdir -p "$destination"
if [ "${plugin_target#windows-}" != "$plugin_target" ]; then
  cp "$plugin_dir/target/$rust_target/release/codex-code-statistics.exe" "$destination/"
else
  cp "$plugin_dir/target/$rust_target/release/codex-code-statistics" "$destination/"
  chmod 755 "$destination/codex-code-statistics"
fi
