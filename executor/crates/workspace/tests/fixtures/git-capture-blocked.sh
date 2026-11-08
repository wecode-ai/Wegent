#!/bin/sh
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

set -eu

if [ "$CAPTURE_TEST_STARTUP_DELAY" != 0 ]; then
  /bin/sleep "$CAPTURE_TEST_STARTUP_DELAY"
fi
printf '%s\n' "$$" > "$CAPTURE_TEST_PID"
exec /bin/cat "$CAPTURE_TEST_FIFO"
