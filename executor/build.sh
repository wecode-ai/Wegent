#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -e

echo "Building executor binary..."
cd /app/executor
pyinstaller executor.spec --clean

echo "Binary built successfully at: /app/executor/dist/executor"
ls -lh /app/executor/dist/executor
