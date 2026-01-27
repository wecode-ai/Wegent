# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal event bus for decoupled module communication.

This module provides a simple async event bus for publishing and subscribing
to internal application events. It enables loose coupling between modules
by allowing them to communicate through events rather than direct calls.

Usage:
    # Define an event
    @dataclass
    class ChatCompletedEvent:
        user_id: int
        task_id: int

    # Subscribe to events (typically in module initialization)
    event_bus.subscribe(ChatCompletedEvent, handle_chat_completed)

    # Publish events (from any module)
    await event_bus.publish(ChatCompletedEvent(user_id=123, task_id=456))
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Type, TypeVar

logger = logging.getLogger(__name__)

# Type variable for event types
T = TypeVar("T")


@dataclass
class ChatCompletedEvent:
    """Event emitted when a chat message is completed.

    Attributes:
        user_id: User ID who completed the chat
    """

    user_id: int


@dataclass
class MemoryCreatedEvent:
    """Event emitted when memories are created.

    Attributes:
        user_id: User ID whose memories were created
        memory_count: Number of memories created
        memory_texts: List of memory text contents for domain detection
    """

    user_id: int
    memory_count: int
    memory_texts: List[str]


class EventBus:
    """Simple async event bus for internal application events.

    This event bus supports:
    - Type-safe event publishing and subscribing
    - Multiple handlers per event type
    - Async handlers with fire-and-forget execution
    - Error isolation (one handler failure doesn't affect others)

    Note: This is an in-process event bus. For cross-process events,
    use Redis Pub/Sub or a message queue.
    """

    def __init__(self) -> None:
        """Initialize the event bus."""
        self._handlers: Dict[Type[Any], List[Callable]] = {}
        self._lock = asyncio.Lock()

    def subscribe(
        self, event_type: Type[T], handler: Callable[[T], Any]
    ) -> Callable[[], None]:
        """Subscribe a handler to an event type.

        Args:
            event_type: The event class to subscribe to
            handler: Async or sync function to call when event is published

        Returns:
            Unsubscribe function that removes the handler

        Example:
            async def handle_chat(event: ChatCompletedEvent):
                print(f"Chat completed for user {event.user_id}")

            unsubscribe = event_bus.subscribe(ChatCompletedEvent, handle_chat)
            # Later: unsubscribe()
        """
        if event_type not in self._handlers:
            self._handlers[event_type] = []

        self._handlers[event_type].append(handler)
        logger.debug(
            "Subscribed handler %s to event %s",
            handler.__name__,
            event_type.__name__,
        )

        def unsubscribe() -> None:
            if event_type in self._handlers and handler in self._handlers[event_type]:
                self._handlers[event_type].remove(handler)
                logger.debug(
                    "Unsubscribed handler %s from event %s",
                    handler.__name__,
                    event_type.__name__,
                )

        return unsubscribe

    async def publish(self, event: T) -> None:
        """Publish an event to all subscribed handlers.

        Handlers are executed concurrently in fire-and-forget mode.
        Errors in handlers are logged but don't propagate to the publisher.

        Args:
            event: The event instance to publish

        Example:
            await event_bus.publish(ChatCompletedEvent(user_id=123))
        """
        event_type = type(event)
        handlers = self._handlers.get(event_type, [])

        logger.info(
            "[EVENT_BUS] Publishing event %s, registered handlers: %d, all_handlers: %s",
            event_type.__name__,
            len(handlers),
            list(self._handlers.keys()),
        )

        if not handlers:
            logger.warning("[EVENT_BUS] No handlers for event %s", event_type.__name__)
            return

        logger.info(
            "[EVENT_BUS] Publishing event %s to %d handlers: %s",
            event_type.__name__,
            len(handlers),
            [h.__name__ for h in handlers],
        )

        # Execute all handlers concurrently
        tasks = []
        for handler in handlers:
            task = asyncio.create_task(self._execute_handler(handler, event))
            tasks.append(task)

        # Wait for all handlers to complete
        # Errors are handled in _execute_handler
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.info(
                "[EVENT_BUS] All handlers completed for event %s", event_type.__name__
            )

    async def _execute_handler(self, handler: Callable, event: Any) -> None:
        """Execute a single handler with error isolation.

        Args:
            handler: The handler function to execute
            event: The event to pass to the handler
        """
        try:
            result = handler(event)
            # If handler is async, await it
            if asyncio.iscoroutine(result):
                await result
        except Exception as e:
            logger.error(
                "Error in event handler %s for event %s: %s",
                handler.__name__,
                type(event).__name__,
                e,
                exc_info=True,
            )

    def clear(self) -> None:
        """Clear all subscriptions. Useful for testing."""
        self._handlers.clear()
        logger.debug("Cleared all event subscriptions")


# Global event bus instance
_event_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    """Get the global event bus instance.

    Returns:
        EventBus: The singleton event bus instance
    """
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
    return _event_bus


def init_event_bus() -> EventBus:
    """Initialize the global event bus.

    This should be called during application startup.

    Returns:
        EventBus: The initialized event bus instance
    """
    global _event_bus
    _event_bus = EventBus()
    logger.info("Event bus initialized")
    return _event_bus
