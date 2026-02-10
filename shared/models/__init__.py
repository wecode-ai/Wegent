# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared models package for Wegent project.

Unified execution protocol - all modules use these classes:
- ExecutionRequest: Unified request format for all execution services
- ExecutionEvent: Unified event format for all execution services
- EventType: Unified event type enum
"""

from . import db

# Unified execution protocol
from .execution import EventType, ExecutionEvent, ExecutionRequest

__all__ = [
    "db",
    # Unified execution protocol
    "EventType",
    "ExecutionEvent",
    "ExecutionRequest",
]
