# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal event bus for decoupled module communication.

This module provides a simple async event bus for publishing and subscribing
to internal application events. It enables loose coupling between modules
by allowing them to communicate through events rather than direct calls.

The event bus handles cross-loop execution gracefully:
- Handlers are executed in the main event loop to ensure proper async context
- If called from a different loop, events are scheduled in the main loop
- Errors in handlers are isolated and don't affect other handlers

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
import concurrent.futures
import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar

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


@dataclass
class TaskCompletedEvent:
    """Event emitted when a task (subtask) is completed.

    This is the unified event for all execution modes (SSE, HTTP+Callback, WebSocket)
    to notify that a task has reached a terminal state.

    Attributes:
        task_id: Task ID
        subtask_id: Subtask ID
        user_id: User ID who owns the task
        status: Terminal status ("COMPLETED", "FAILED", "CANCELLED")
        result: Optional result dict containing output value
        error: Optional error message for FAILED status
    """

    task_id: int
    subtask_id: int
    user_id: int
    status: str  # "COMPLETED" | "FAILED" | "CANCELLED"
    result: Optional[dict] = None
    error: Optional[str] = None


class EventBus:
    """Simple async event bus for internal application events.

    This event bus supports:
    - Type-safe event publishing and subscribing
    - Multiple handlers per event type
    - Async handlers with fire-and-forget execution
    - Error isolation (one handler failure doesn't affect others)
    - Cross-loop execution (handlers run in main loop)

    Note: This is an in-process event bus. For cross-process events,
    use Redis Pub/Sub or a message queue.
    """

    def __init__(self) -> None:
        """Initialize the event bus."""
        self._handlers: Dict[Type[Any], List[Callable]] = {}
        self._main_loop: Optional[asyncio.AbstractEventLoop] = None

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
        logger.info(
            "[EVENT_BUS] Subscribed handler %s to event %s",
            handler.__name__,
            event_type.__name__,
        )

        def unsubscribe() -> None:
            if event_type in self._handlers and handler in self._handlers[event_type]:
                self._handlers[event_type].remove(handler)
                logger.info(
                    "[EVENT_BUS] Unsubscribed handler %s from event %s",
                    handler.__name__,
                    event_type.__name__,
                )

        return unsubscribe

    async def publish(self, event: T) -> None:
        """Publish an event to all subscribed handlers.

        Handlers are executed concurrently in fire-and-forget mode.
        Errors in handlers are logged but don't propagate to the publisher.

        IMPORTANT: This method must be called from an active event loop context.
        It is an async method and requires `await`. If called without a running
        event loop, a RuntimeError will be raised.

        Note: In Celery worker context, events are skipped because WebSocket
        operations cannot work across process boundaries.

        Cross-loop handling:
        - If called from main loop, handlers execute directly
        - If called from different loop, handlers are scheduled in main loop

        Args:
            event: The event instance to publish

        Raises:
            RuntimeError: If called without a running event loop

        Example:
            await event_bus.publish(ChatCompletedEvent(user_id=123))
        """
        # Skip event publishing in Celery worker context
        # WebSocket operations don't work across process boundaries
        from app.services.chat.ws_emitter import get_ws_emitter

        ws_emitter = get_ws_emitter()
        if ws_emitter is None:
            # Log detailed info for debugging subscription execution status issue
            import threading

            logger.warning(
                "[EVENT_BUS] get_ws_emitter() returned None for event %s - "
                "thread=%s, thread_id=%s, is_daemon=%s. "
                "This may cause subscription execution status not to update!",
                type(event).__name__,
                threading.current_thread().name,
                threading.current_thread().ident,
                threading.current_thread().daemon,
            )
            # For TaskCompletedEvent, we should NOT skip - it's needed for subscription status update
            # The handler (SubscriptionTaskCompletionHandler) doesn't need WebSocket
            if type(event).__name__ == "TaskCompletedEvent":
                logger.info(
                    "[EVENT_BUS] TaskCompletedEvent detected, proceeding despite no ws_emitter "
                    "(subscription status update doesn't need WebSocket)"
                )
            else:
                logger.info(
                    "[EVENT_BUS] Skipping event %s - not in FastAPI context (likely Celery worker)",
                    type(event).__name__,
                )
                return

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

        # Get current event loop - publish() is async so there must be a running loop
        # If not, this is a programming error and should fail explicitly
        current_loop = asyncio.get_running_loop()

        # Check if we're in a different loop than the main loop
        is_different_loop = (
            self._main_loop is not None and current_loop is not self._main_loop
        )

        if is_different_loop:
            # For TaskCompletedEvent, execute handlers directly in current loop.
            # This is critical because:
            # 1. SubscriptionTaskCompletionHandler only updates database, doesn't need WebSocket
            # 2. asyncio.run_coroutine_threadsafe schedules tasks but main loop may not process them
            #    (observed issue: tasks only execute when server shuts down)
            # 3. Executing directly in current loop ensures immediate execution
            if type(event).__name__ == "TaskCompletedEvent":
                logger.info(
                    "[EVENT_BUS] TaskCompletedEvent from different loop, "
                    "executing handlers directly in current loop "
                    "(handler doesn't need main loop context, avoids scheduling issues)"
                )
                await self._execute_handlers(handlers, event)
                return

            # For other events that may need WebSocket/main loop context,
            # schedule in main loop if it's running
            if self._main_loop.is_running():
                logger.info(
                    "[EVENT_BUS] Publishing from different loop, scheduling in main loop"
                )
                await self._schedule_in_main_loop(handlers, event)
                return
            else:
                logger.warning(
                    "[EVENT_BUS] Main loop not running, executing handlers in current loop"
                )

        # Execute handlers in current loop
        await self._execute_handlers(handlers, event)

    async def _schedule_in_main_loop(self, handlers: List[Callable], event: T) -> None:
        """Schedule handler execution in the main event loop and wait for completion.

        This method schedules handlers in the main loop and attaches a callback
        to log any exceptions from the Future. Since we're in a different loop,
        we cannot directly await the result, but we ensure exceptions are logged.

        Args:
            handlers: List of handlers to execute
            event: Event to pass to handlers
        """
        if self._main_loop is None or not self._main_loop.is_running():
            logger.warning(
                "[EVENT_BUS] Main loop not available, skipping handlers for event %s "
                "(executing in wrong loop would cause errors)",
                type(event).__name__,
            )
            return

        async def run_handlers() -> None:
            await self._execute_handlers(handlers, event)

        def done_callback(future: "concurrent.futures.Future[None]") -> None:
            """Log any exceptions from the scheduled handlers."""
            try:
                future.result()
            except Exception:
                logger.exception(
                    "[EVENT_BUS] Exception in cross-loop handlers for event %s",
                    type(event).__name__,
                )

        try:
            future = asyncio.run_coroutine_threadsafe(run_handlers(), self._main_loop)
            # Attach callback to log exceptions - we can't await across loops
            future.add_done_callback(done_callback)
            logger.info(
                "[EVENT_BUS] Scheduled %d handlers in main loop for event %s",
                len(handlers),
                type(event).__name__,
            )
        except Exception:
            # Failed to schedule - log and skip (don't execute in wrong loop)
            logger.exception(
                "[EVENT_BUS] Failed to schedule handlers in main loop for event %s, "
                "handlers will not be executed",
                type(event).__name__,
            )

    async def _execute_handlers(self, handlers: List[Callable], event: T) -> None:
        """Execute all handlers concurrently.

        Args:
            handlers: List of handlers to execute
            event: Event to pass to handlers
        """
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
                "[EVENT_BUS] All handlers completed for event %s", type(event).__name__
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
                "[EVENT_BUS] Error in event handler %s for event %s: %s",
                handler.__name__,
                type(event).__name__,
                e,
                exc_info=True,
            )

    def clear(self) -> None:
        """Clear all subscriptions. Useful for testing."""
        self._handlers.clear()
        logger.info("[EVENT_BUS] Cleared all event subscriptions")


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

    This should be called during application startup from within an async context.
    Captures the main event loop reference for cross-loop scheduling.

    Returns:
        EventBus: The initialized event bus instance
    """
    global _event_bus
    _event_bus = EventBus()

    # Capture main event loop reference - only use get_running_loop()
    # as get_event_loop() is deprecated in Python 3.10+
    try:
        _event_bus._main_loop = asyncio.get_running_loop()
        logger.info("[EVENT_BUS] Event bus initialized with main event loop reference")
    except RuntimeError:
        # No running loop during initialization - this is expected if called
        # before the async context starts. The loop will be set later.
        logger.warning(
            "[EVENT_BUS] Event bus initialized without event loop reference "
            "(will be set when async context starts)"
        )

    # Also set the main loop in async_utils for consistency
    if _event_bus._main_loop is not None:
        from app.core.async_utils import set_main_event_loop

        set_main_event_loop(_event_bus._main_loop)

    return _event_bus
