# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Warm pool executor module for kubernetes-sigs/agent-sandbox integration.

This module provides warm pool-based pod creation using the agent-sandbox CRDs:
- sandboxes.agents.x-k8s.io
- sandboxtemplates.extensions.agents.x-k8s.io
- sandboxwarmpools.extensions.agents.x-k8s.io
"""

from executor_manager.wecode.executors.warmpool.warmpool_client import (
    WarmPoolClient,
)

__all__ = ["WarmPoolClient"]
