# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox module for executing code in isolated containers.

This module provides:
- SandboxClient: HTTP client for executor_manager's sandbox API
- SandboxManager: E2B SDK-based sandbox lifecycle management (singleton per task)
- BaseSandboxTool: Base class for sandbox tools with common dependencies
- patch_e2b_sdk: Function to patch E2B SDK for Wegent protocol
"""

from chat_shell.tools.sandbox._base import (
    DEFAULT_EXECUTOR_MANAGER_URL,
    DEFAULT_SANDBOX_TIMEOUT,
    BaseSandboxTool,
    SandboxManager,
    patch_e2b_sdk,
)
from chat_shell.tools.sandbox.client import SandboxClient

__all__ = [
    # HTTP Client
    "SandboxClient",
    # E2B SDK based
    "SandboxManager",
    "BaseSandboxTool",
    "patch_e2b_sdk",
    # Constants
    "DEFAULT_EXECUTOR_MANAGER_URL",
    "DEFAULT_SANDBOX_TIMEOUT",
]
