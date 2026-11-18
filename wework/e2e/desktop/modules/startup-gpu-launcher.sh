#!/bin/sh

# Chrome owns this launcher PID and may kill it during shutdown. A separate
# observer owns the actual GPU child and records only that child's wait status.
if [ "${1-}" != '--observe' ]; then
  /bin/sh "$0" --observe "$$" "$PPID" "$@" <&0 &
  wait "$!"
  exit "$?"
fi

launcher_pid=$2
parent_pid=$3
shift 3
evidence_path=${WEWORK_E2E_GPU_EVIDENCE_PATH-}
evidence_path_json=${WEWORK_E2E_GPU_EVIDENCE_PATH_JSON-}
nonce=${WEWORK_E2E_GPU_EVIDENCE_NONCE-}
case "$launcher_pid:$parent_pid" in
  *[!0-9:]*|:*|*:) exit 125 ;;
esac
case "$nonce" in
  ''|*[!0-9a-f]*) exit 125 ;;
esac
if [ "${#nonce}" -ne 32 ] || [ -z "$evidence_path" ] || [ -z "$evidence_path_json" ] || [ "$#" -eq 0 ]; then
  exit 125
fi

umask 077
# A GPU SIGTRAP is evidence, not a reason to leave a potentially sensitive core.
ulimit -c 0 || exit 125
# Keep every inherited descriptor, including Chromium's Mojo descriptors.
exec "$@" <&0 &
gpu_pid=$!
if ! printf '{"event":"started","casePath":%s,"nonce":"%s","launcherPid":%s,"parentPid":%s,"observerPid":%s,"actualGpuPid":%s}\n' \
  "$evidence_path_json" "$nonce" "$launcher_pid" "$parent_pid" "$$" "$gpu_pid" >> "$evidence_path"; then
  kill "$gpu_pid"
  wait "$gpu_pid"
  exit 125
fi

# No signal trap converts an interrupted observer wait into GPU exit evidence.
wait "$gpu_pid"
gpu_status=$?
printf '{"event":"exited","casePath":%s,"nonce":"%s","launcherPid":%s,"parentPid":%s,"observerPid":%s,"actualGpuPid":%s,"status":%s}\n' \
  "$evidence_path_json" "$nonce" "$launcher_pid" "$parent_pid" "$$" "$gpu_pid" "$gpu_status" >> "$evidence_path" || exit 125
exit "$gpu_status"
