# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

: "${EXECUTOR_VERSION:?missing resolved Executor version}"

rm -rf ./executor ./sdk ./shared
cp -r ../../../executor ./executor
printf '%s\n' "$EXECUTOR_VERSION" > ./executor/.build-version
mkdir -p ./sdk
cp -r ../../../sdk/plugin-auth ./sdk/plugin-auth
cp -r ../../../sdk/plugin-creator ./sdk/plugin-creator
mkdir -p ./shared
cp -r ../../../shared/assets ./shared/assets
