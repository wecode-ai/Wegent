"""Chat Shell API - Boundary Contracts.

This module defines the boundary contracts for Chat Shell service:
- ChatEvent: Input contract for Chat Shell
- StreamEvent: Output contract for Chat Shell

These contracts define the interface between Chat Shell and external systems.
"""

from .schemas import (
    ChatEvent,
    ChatEventType,
    StreamEvent,
    StreamEventType,
)

__all__ = [
    "ChatEvent",
    "ChatEventType",
    "StreamEvent",
    "StreamEventType",
]
