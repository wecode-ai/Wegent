# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# todo: placeholder for now, will be changed to open source project later
docker buildx build --network=host  --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-base-python3.12:1.0.1 -f Dockerfile .