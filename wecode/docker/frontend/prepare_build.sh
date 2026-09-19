# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -eu

rm -rf frontend packages patches shared package.json pnpm-lock.yaml pnpm-workspace.yaml

cp -R ../../../frontend ./frontend
mkdir -p ./packages
cp -R ../../../packages/chat-core ./packages/chat-core
cp -R ../../../packages/collaboration ./packages/collaboration
cp -R ../../../patches ./patches
mkdir -p ./shared
cp -R ../../../shared/assets ./shared/assets
cp ../../../package.json ../../../pnpm-lock.yaml ../../../pnpm-workspace.yaml ./
cp -f .env.local ./frontend/.env.local

rm -rf \
  ./frontend/node_modules \
  ./frontend/.next \
  ./frontend/.swc \
  ./frontend/coverage \
  ./frontend/playwright-report \
  ./frontend/test-results \
  ./frontend/tsconfig.tsbuildinfo \
  ./packages/chat-core/node_modules \
  ./packages/collaboration/node_modules
