#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -e

echo "Building executor binary..."
cd /app/executor
cargo build --release --locked

mkdir -p /app/executor/dist
cp /app/executor/target/release/wegent-executor /app/executor/dist/wegent-executor

echo "Binary built successfully at: /app/executor/dist/wegent-executor"
ls -lh /app/executor/dist/wegent-executor
