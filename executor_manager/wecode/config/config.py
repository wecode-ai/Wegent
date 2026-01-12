# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

K8S_NAMESPACE = os.getenv("K8S_NAMESPACE", "wb-plat-ide")
EXECUTOR_DEFAULT_MAGE = os.getenv(
    "EXECUTOR_IMAGE",
    "",
)

MAX_USER_TASKS = int(os.getenv("MAX_USER_TASKS", 10))
USER_WHITELIST_TASK_LIMIT_MAP = os.getenv("USER_WHITELIST_TASK_LIMIT_MAP", "{}")

REPO_PROXY_CONFIG = os.getenv(
    "REPO_PROXY_CONFIG",
    '{"github.com":{"http.proxy":"http://wproxy.intra.weibo.com:8889","https.proxy":"http://wproxy.intra.weibo.com:8889"}}',
)

EXECUTOR_CUSTOM_CONFIG = os.getenv(
    "EXECUTOR_CUSTOM_CONFIG",
    '{"wecode_config": "executor.wecode.config.config.WeCodeConfig"}',
)
