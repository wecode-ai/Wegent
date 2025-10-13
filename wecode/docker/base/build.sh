# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# todo: 先占位, 后续改为开源项目
docker buildx build --platform linux/amd64 -t registry.api.weibo.com/wecode/wegent-base-python3.12:1.0.1-java-support -f Dockerfile . --push
