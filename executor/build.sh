#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -e

echo "Building executor binary..."
cd /app/executor
if [ -n "${EXECUTOR_CARGO_FEATURES:-}" ]; then
    cargo build --release --locked --features "${EXECUTOR_CARGO_FEATURES}"
else
    cargo build --release --locked
fi

mkdir -p /app/executor/dist
cp /app/executor/target/release/wegent-executor /app/executor/dist/wegent-executor

echo "Binary built successfully at: /app/executor/dist/wegent-executor"
ls -lh /app/executor/dist/wegent-executor
