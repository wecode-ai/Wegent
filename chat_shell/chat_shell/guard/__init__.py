# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Guard context governance package (Phase 2)."""

from chat_shell.guard.types import (
    DEFAULT_EMERGENCY_RATIO,
    GuardSource,
    TruncationPolicy,
    default_emergency_policy,
)

__all__ = [
    "DEFAULT_EMERGENCY_RATIO",
    "GuardSource",
    "TruncationPolicy",
    "default_emergency_policy",
]
