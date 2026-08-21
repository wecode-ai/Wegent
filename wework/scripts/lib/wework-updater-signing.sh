#!/usr/bin/env bash

wework_configure_internal_updater_key() {
  local project_dir="$1"
  local updater_key_path="$2"
  local key_dir
  local public_key_path="$updater_key_path.pub"

  key_dir="$(dirname "$updater_key_path")"
  mkdir -p "$key_dir"
  chmod 700 "$key_dir"

  if [ ! -f "$updater_key_path" ] && [ ! -f "$public_key_path" ]; then
    echo "Generating internal updater key: $updater_key_path"
    (
      cd "$project_dir"
      /usr/bin/env \
        -u TAURI_SIGNING_PRIVATE_KEY \
        -u TAURI_SIGNING_PRIVATE_KEY_PATH \
        -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
        pnpm --filter wework exec tauri signer generate \
          --write-keys "$updater_key_path" \
          --ci >/dev/null
    )
  fi

  if [ ! -s "$updater_key_path" ] || [ ! -s "$public_key_path" ]; then
    echo "Updater private/public key pair is incomplete: $updater_key_path" >&2
    return 1
  fi

  chmod 600 "$updater_key_path"
  TAURI_SIGNING_PRIVATE_KEY="$(< "$updater_key_path")"
  export TAURI_SIGNING_PRIVATE_KEY
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$updater_key_path"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  TAURI_UPDATER_PUBKEY="$(< "$public_key_path")"
  export TAURI_UPDATER_PUBKEY
}
