#!/bin/sh
set -eu

: "${DISPLAY:?Native accessibility requires its isolated Xvfb display}"
: "${DBUS_SESSION_BUS_ADDRESS:?Native accessibility requires its own D-Bus session}"

gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
  --method org.freedesktop.DBus.Properties.Set org.a11y.Status IsEnabled '<true>'
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
  --method org.a11y.Bus.GetAddress
if ! xprop -root AT_SPI_BUS | grep -q ' = "'; then
  echo 'AT-SPI did not publish its bus on the isolated Xvfb display' >&2
  exit 1
fi

exec "$@"
