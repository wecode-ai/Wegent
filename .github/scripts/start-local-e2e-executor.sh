#!/usr/bin/env bash

set -euo pipefail

binary_path="${1:?Executor binary path is required}"
log_path="${2:?Executor log path is required}"
pid_path="${3:?Executor PID path is required}"
backend_url="${WEGENT_BACKEND_URL:?WEGENT_BACKEND_URL is required}"
device_id="${DEVICE_ID:?DEVICE_ID is required}"

for _ in {1..120}; do
  if curl -sf "$backend_url/api/docs" >/dev/null; then
    break
  fi
  sleep 1
done
curl -sf "$backend_url/api/docs" >/dev/null

token="$(
  uv run --project backend python - <<'PY'
import json
import os
import urllib.error
import urllib.request

api_base_url = f"{os.environ['WEGENT_BACKEND_URL'].rstrip('/')}/api"
admin_password = os.environ["E2E_BOOTSTRAP_ADMIN_PASSWORD"]


def request_json(path, *, method="GET", payload=None, allowed_statuses=()):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base_url}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in allowed_statuses:
            return None
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"{method} {path} failed with HTTP {error.code}: {body}"
        ) from error


request_json(
    "/auth/admin-password/setup",
    method="POST",
    payload={"password": admin_password},
    allowed_statuses=(409,),
)
token_response = request_json(
    "/auth/login",
    method="POST",
    payload={"user_name": "admin", "password": admin_password},
)
print(token_response["access_token"])
PY
)"

test -x "$binary_path"
if [[ -n "${CODEX_BINARY_PATH:-}" ]]; then
  test -x "$CODEX_BINARY_PATH"
fi
mkdir -p "$(dirname "$log_path")" "$(dirname "$pid_path")"
executor_env=(
  -u GIT_TOKEN_AES_KEY
  -u GIT_TOKEN_AES_IV
  WEGENT_AUTH_TOKEN="$token"
)
if [[ -n "${E2E_EXECUTOR_USER:-}" ]]; then
  if [[ "$(id -u)" != "0" ]]; then
    echo "E2E_EXECUTOR_USER requires a root launcher" >&2
    exit 1
  fi
  user_home="$(getent passwd "$E2E_EXECUTOR_USER" | cut -d: -f6)"
  test -n "$user_home"
  mkdir -p \
    "$user_home" \
    "${WEGENT_EXECUTOR_HOME:-$user_home/.wegent-executor}" \
    "${LOCAL_WORKSPACE_ROOT:-$user_home/workspace}"
  chown -R "$E2E_EXECUTOR_USER":"$E2E_EXECUTOR_USER" \
    "$user_home" \
    "${WEGENT_EXECUTOR_HOME:-$user_home/.wegent-executor}" \
    "${LOCAL_WORKSPACE_ROOT:-$user_home/workspace}" \
    "$(dirname "$log_path")" \
    "$(dirname "$pid_path")"
  executor_env+=(
    HOME="$user_home"
    WEGENT_EXECUTOR_HOME="${WEGENT_EXECUTOR_HOME:-$user_home/.wegent-executor}"
  )
  nohup runuser -u "$E2E_EXECUTOR_USER" -- env \
    "${executor_env[@]}" \
    "$binary_path" >"$log_path" 2>&1 &
else
  nohup env \
    "${executor_env[@]}" \
    "$binary_path" >"$log_path" 2>&1 &
fi
echo $! >"$pid_path"

for _ in {1..60}; do
  if curl -sf \
    -H "Authorization: Bearer $token" \
    "$backend_url/api/devices" |
    DEVICE_ID="$device_id" python -c '
import json
import os
import sys

items = json.load(sys.stdin).get("items", [])
expected = os.environ["DEVICE_ID"]
raise SystemExit(
    0
    if any(
        item.get("device_id") == expected and item.get("status") == "online"
        for item in items
    )
    else 1
)
'; then
    exit 0
  fi
  sleep 1
done

cat "$log_path"
exit 1
