#!/bin/sh
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

set -eu

printf '%s\n' "$$" > "$CAPTURE_TEST_PID"
exec /bin/cat "$CAPTURE_TEST_FIFO"
