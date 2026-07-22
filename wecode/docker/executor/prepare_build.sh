# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

rm -rf ./executor ./shared
cp -r ../../../executor ./executor
mkdir -p ./shared
cp -r ../../../shared/assets ./shared/assets
