# Shared environment loader for WeWork iOS scripts.
# Sourced (not executed) by build-ios-app.sh and dev-ios-app.sh.
#
# Responsibilities:
#   - Resolve project paths (SCRIPT_DIR, WEWORK_DIR, ENV_DIR).
#   - Load a per-environment config file (scripts/ios-env/<ENV>.env).
#   - Export the VITE_* variables consumed by src/config/runtime.ts.
#
# NOTE: iOS native builds have no Vite dev proxy, so VITE_WEGENT_BACKEND_URL
# MUST be an absolute URL reachable from the device/simulator.

# Resolve directories relative to this library file.
WEWORK_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEWORK_SCRIPTS_DIR="$(cd "$WEWORK_LIB_DIR/.." && pwd)"
WEWORK_DIR="$(cd "$WEWORK_SCRIPTS_DIR/.." && pwd)"
WEWORK_ENV_DIR="$WEWORK_SCRIPTS_DIR/ios-env"

# load_wework_env <env-name>
# Sources scripts/ios-env/<env-name>.env with auto-export so every key=value pair
# becomes an exported variable for the subsequent `tauri ios` invocation.
load_wework_env() {
  local env_name="$1"

  if [ -z "$env_name" ]; then
    echo "error: environment name is required" >&2
    return 1
  fi

  local env_file="$WEWORK_ENV_DIR/$env_name.env"
  if [ ! -f "$env_file" ]; then
    echo "error: env file not found: $env_file" >&2
    echo "       available environments:" >&2
    local f
    for f in "$WEWORK_ENV_DIR"/*.env; do
      [ -e "$f" ] || continue
      echo "         - $(basename "$f" .env)" >&2
    done
    return 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  WEWORK_RESOLVED_ENV_FILE="$env_file"
  return 0
}

# print_wework_env_summary <env-name>
# Echoes the resolved build configuration for visibility in CI logs.
print_wework_env_summary() {
  local env_name="$1"
  echo "  ENV=$env_name"
  echo "  ENV_FILE=${WEWORK_RESOLVED_ENV_FILE:-<none>}"
  echo "  VITE_WEGENT_BACKEND_URL=${VITE_WEGENT_BACKEND_URL:-<unset>}"
  echo "  VITE_APP_BASE_PATH=${VITE_APP_BASE_PATH:-<unset>}"
  echo "  APPLE_DEVELOPMENT_TEAM=${APPLE_DEVELOPMENT_TEAM:-<unset>}"
}
