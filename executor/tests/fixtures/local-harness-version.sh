#!/bin/sh
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -eu
test "$#" -eq 1
test "$1" = '--version'
printf '%s\n' '2.1.228 (Claude Code)'
