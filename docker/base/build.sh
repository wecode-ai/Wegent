# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# todo: 先占位, 后续改为开源项目
docker buildx build --network=host  --platform linux/amd64,linux/arm64 -t ghcr.io/wecode-ai/wegent-base-python3.12:1.0.0 -f Dockerfile .