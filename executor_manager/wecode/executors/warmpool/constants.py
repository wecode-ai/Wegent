# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Constants for kubernetes-sigs/agent-sandbox CRDs.

CRD References:
- https://github.com/kubernetes-sigs/agent-sandbox

CRDs:
- sandboxclaims.extensions.agents.x-k8s.io - Claim pods from warm pool
- sandboxes.agents.x-k8s.io - Sandbox instances (created by controller)
- sandboxtemplates.extensions.agents.x-k8s.io - Pod templates
- sandboxwarmpools.extensions.agents.x-k8s.io - Warm pool configuration
"""

# SandboxClaim CRD (sandboxclaims.extensions.agents.x-k8s.io)
# User creates this to claim a pod from the warm pool
SANDBOX_CLAIM_API_GROUP = "extensions.agents.x-k8s.io"
SANDBOX_CLAIM_API_VERSION = "v1alpha1"
SANDBOX_CLAIM_PLURAL = "sandboxclaims"
SANDBOX_CLAIM_KIND = "SandboxClaim"

# Sandbox CRD (sandboxes.agents.x-k8s.io)
# Created by controller when SandboxClaim is processed
SANDBOX_API_GROUP = "agents.x-k8s.io"
SANDBOX_API_VERSION = "v1alpha1"
SANDBOX_PLURAL = "sandboxes"
SANDBOX_KIND = "Sandbox"

# SandboxTemplate CRD (sandboxtemplates.extensions.agents.x-k8s.io)
SANDBOX_TEMPLATE_API_GROUP = "extensions.agents.x-k8s.io"
SANDBOX_TEMPLATE_API_VERSION = "v1alpha1"
SANDBOX_TEMPLATE_PLURAL = "sandboxtemplates"
SANDBOX_TEMPLATE_KIND = "SandboxTemplate"

# SandboxWarmPool CRD (sandboxwarmpools.extensions.agents.x-k8s.io)
SANDBOX_WARMPOOL_API_GROUP = "extensions.agents.x-k8s.io"
SANDBOX_WARMPOOL_API_VERSION = "v1alpha1"
SANDBOX_WARMPOOL_PLURAL = "sandboxwarmpools"
SANDBOX_WARMPOOL_KIND = "SandboxWarmPool"

# Wegent labels
LABEL_EXECUTOR = "aigc.weibo.com/executor"
LABEL_EXECUTOR_VALUE = "wegent"
LABEL_TASK_ID = "aigc.weibo.com/executor-task-id"
LABEL_USER = "aigc.weibo.com/user"
LABEL_PROXY_USER = "aigc.weibo.com/proxy-user"
LABEL_TASK_TYPE = "aigc.weibo.com/task-type"
LABEL_TEAM_MODE = "aigc.weibo.com/team-mode"

# Wegent annotations
ANNOTATION_EMAIL = "aigc.weibo.com/email"
ANNOTATION_TASK_INFO = "aigc.weibo.com/task-info"
ANNOTATION_AUTH_TOKEN = "aigc.weibo.com/auth-token"
ANNOTATION_TASK_ID = "aigc.weibo.com/executor-task-id"
ANNOTATION_CALLBACK_URL = "aigc.weibo.com/callback-url"
ANNOTATION_TASK_API_DOMAIN = "aigc.weibo.com/task-api-domain"
ANNOTATION_HEARTBEAT_BASE_URL = "aigc.weibo.com/executor-manager-heartbeat-base-url"
ANNOTATION_HEARTBEAT_ID = "aigc.weibo.com/heartbeat-id"
ANNOTATION_HEARTBEAT_ENABLED = "aigc.weibo.com/heartbeat-enabled"
ANNOTATION_HEARTBEAT_TYPE = "aigc.weibo.com/heartbeat-type"

# Config file paths (DownwardAPI mount points)
CONFIG_DIR = "/root/.wegent/.config"
CONFIG_TASK_INFO = f"{CONFIG_DIR}/task_info"
CONFIG_USER = f"{CONFIG_DIR}/user"
CONFIG_AUTH_TOKEN = f"{CONFIG_DIR}/auth_token"
CONFIG_TASK_ID = f"{CONFIG_DIR}/task_id"
CONFIG_EXECUTOR_NAME = f"{CONFIG_DIR}/executor_name"

# Default warm pool settings
DEFAULT_WARMPOOL_SIZE = 5
DEFAULT_WARMPOOL_MIN_REPLICAS = 2
DEFAULT_WARMPOOL_MAX_REPLICAS = 20
DEFAULT_WARMPOOL_MAX_IDLE_TIME = "30m"
DEFAULT_WARMPOOL_TERMINATION_GRACE_PERIOD = "60s"

# Sandbox status phases
SANDBOX_PHASE_PENDING = "Pending"
SANDBOX_PHASE_RUNNING = "Running"
SANDBOX_PHASE_SUCCEEDED = "Succeeded"
SANDBOX_PHASE_FAILED = "Failed"
SANDBOX_PHASE_TERMINATED = "Terminated"
