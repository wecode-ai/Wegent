# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell unified interface definitions.

This module defines the contract between Backend and Chat Shell,
supporting both package import and HTTP/SSE communication modes.

Note: ChatRequest, ChatEvent, and ChatEventType have been removed.
Use ExecutionRequest, ExecutionEvent, and EventType from shared.models.execution instead.
"""

# Re-export unified types from shared.models.execution for backward compatibility
from shared.models.execution import EventType, ExecutionEvent, ExecutionRequest

# Backward compatibility aliases (deprecated, will be removed in future versions)
# These are provided to ease migration but should not be used in new code
ChatEventType = EventType
ChatEvent = ExecutionEvent
ChatRequest = ExecutionRequest

__all__ = [
    # New unified types (preferred)
    "ExecutionRequest",
    "ExecutionEvent",
    "EventType",
    # Deprecated aliases (for backward compatibility only)
    "ChatRequest",
    "ChatEvent",
    "ChatEventType",
]
