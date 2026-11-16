# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Sandbox skill base module - re-exports from chat_shell.

This module re-exports the sandbox base classes from chat_shell.tools.sandbox
to maintain backward compatibility with existing skill tools.

All sandbox tools should import from this module to ensure consistent behavior.

"""

# Re-export from chat_shell.tools.sandbox
from chat_shell.tools.sandbox import (
    DEFAULT_EXECUTOR_MANAGER_URL,
    DEFAULT_SANDBOX_TIMEOUT,
    BaseSandboxTool,
    SandboxManager,
)

__all__ = [
    "SandboxManager",
    "BaseSandboxTool",
    "DEFAULT_EXECUTOR_MANAGER_URL",
    "DEFAULT_SANDBOX_TIMEOUT",
]
