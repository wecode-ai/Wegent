#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Ensures every executor subprocess goes through
# crate::process::{command, command_sync, shell} so Windows console windows
# stay hidden by default. Ad-hoc Command::new sites tend to forget
# CREATE_NO_WINDOW and reintroduce console flashes on Windows.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXECUTOR_SRC="$REPO_ROOT/executor/src"

find "$EXECUTOR_SRC" -name '*.rs' -print0 | xargs -0 awk '
  BEGIN { in_test = 0; depth = 0; bad = 0 }
  FILENAME ~ /wegent-executor-dev\.rs$/ { nextfile }
  FILENAME ~ /tests\.rs$/ { nextfile }
  /^#\[cfg\(/ && /test/ { in_test = 1; next }
  in_test {
    depth += gsub(/\{/, "x") - gsub(/\}/, "x")
    if (depth <= 0) { in_test = 0; depth = 0 }
    next
  }
  /Command::new\(/ && FILENAME !~ /process\/spawn\.rs$/ {
    print FILENAME ":" FNR ": use crate::process::command()/command_sync()/shell() instead of Command::new()"
    bad = 1
  }
  END { exit bad }
'
