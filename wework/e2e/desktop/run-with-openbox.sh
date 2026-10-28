#!/bin/sh
set -eu

if [ "${WEWORK_TEST_SECRET_SESSION:-}" != '1' ]; then
  exec dbus-run-session -- env WEWORK_TEST_SECRET_SESSION=1 sh "$0" "$@"
fi
taskSecretDirectory=$(mktemp -d "${TMPDIR:-/tmp}/wework-secret-service.XXXXXX")
trap 'rm -rf "$taskSecretDirectory"' 0
# A private D-Bus session and data directory keep synthetic CI secrets isolated.
printf '\n' | env XDG_DATA_HOME="$taskSecretDirectory" gnome-keyring-daemon --unlock --components=secrets >/dev/null

openbox >/tmp/wework-e2e-openbox.log 2>&1 &

attempt=0
while [ "$attempt" -lt 100 ]; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q '_NET_SUPPORTING_WM_CHECK'; then
    "$@"
    exit $?
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done

cat /tmp/wework-e2e-openbox.log >&2
echo 'Openbox did not register with the isolated Xvfb display' >&2
exit 1
