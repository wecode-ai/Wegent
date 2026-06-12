# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -eu

rm -rf wework packages package.json pnpm-lock.yaml pnpm-workspace.yaml

cp -R ../../../wework ./wework
mkdir -p ./packages
cp -R ../../../packages/chat-core ./packages/chat-core
cp ../../../package.json ../../../pnpm-lock.yaml ../../../pnpm-workspace.yaml ./

rm -rf \
  ./wework/node_modules \
  ./wework/dist \
  ./wework/.vite \
  ./wework/coverage \
  ./packages/chat-core/node_modules
