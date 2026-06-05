# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Guard context governance package (Phase 2)."""

from chat_shell.guard.tool_output import (
    COMPACTED_FLAG,
    HEAD_RATIO,
    HEADER_PREFIX,
    RawToolOutput,
    ToolOutputGuardAdapter,
)
from chat_shell.guard.types import (
    DEFAULT_EMERGENCY_RATIO,
    GuardSource,
    TruncationPolicy,
    default_emergency_policy,
)

__all__ = [
    "COMPACTED_FLAG",
    "DEFAULT_EMERGENCY_RATIO",
    "HEAD_RATIO",
    "HEADER_PREFIX",
    "GuardSource",
    "RawToolOutput",
    "ToolOutputGuardAdapter",
    "TruncationPolicy",
    "default_emergency_policy",
]
