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

# ==================== Warm Pool Configuration ====================

# Enable warm pool mode (use pre-warmed pods instead of direct pod creation)
WARMPOOL_ENABLED = os.getenv("WARMPOOL_ENABLED", "false").lower() == "true"

# Name of the SandboxTemplate to use for warm pool
WARMPOOL_TEMPLATE_NAME = os.getenv("WARMPOOL_TEMPLATE_NAME", "wegent-executor-template")

# Name of the SandboxWarmPool CR
WARMPOOL_NAME = os.getenv("WARMPOOL_NAME", "wegent-executor-warmpool")

# Number of warm pods to maintain in the pool
WARMPOOL_SIZE = int(os.getenv("WARMPOOL_SIZE", "5"))

# Scaling configuration
WARMPOOL_MIN_REPLICAS = int(os.getenv("WARMPOOL_MIN_REPLICAS", "2"))
WARMPOOL_MAX_REPLICAS = int(os.getenv("WARMPOOL_MAX_REPLICAS", "20"))

# Maximum idle time before pod recycling (e.g., "30m", "1h")
WARMPOOL_MAX_IDLE_TIME = os.getenv("WARMPOOL_MAX_IDLE_TIME", "30m")

# ==================== Executor Manager URLs ====================

# Task API domain (backend service URL)
TASK_API_DOMAIN = os.getenv("TASK_API_DOMAIN", "")

# Executor manager URL (base URL for executor manager service)
EXECUTOR_MANAGER_URL = os.getenv(
    "EXECUTOR_MANAGER_URL",
    "http://wegent-executor-manager-web.wb-plat-ide:8080",
)

# Executor manager heartbeat base URL
EXECUTOR_MANAGER_HEARTBEAT_BASE_URL = os.getenv("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL", "")

# Callback URL for executor (derived from EXECUTOR_MANAGER_URL)
CALLBACK_URL = EXECUTOR_MANAGER_URL + "/executor-manager/callback"
