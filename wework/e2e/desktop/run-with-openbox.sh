#!/bin/sh
set -eu

openbox >/tmp/wework-e2e-openbox.log 2>&1 &

attempt=0
while [ "$attempt" -lt 100 ]; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q '_NET_SUPPORTING_WM_CHECK'; then
    exec "$@"
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done

cat /tmp/wework-e2e-openbox.log >&2
echo 'Openbox did not register with the isolated Xvfb display' >&2
exit 1
