# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Event emitter abstraction for chat streaming.

This module provides an abstraction layer for emitting chat events,
allowing different implementations for different contexts:
- WebSocketEventEmitter: For real-time WebSocket communication
- NoOpEventEmitter: For background tasks without WebSocket (e.g., Subscription Scheduler)
- SubscriptionEventEmitter: For Subscription Scheduler tasks that need to update BackgroundExecution status

This separation follows the Strategy pattern, keeping business logic
independent of the event delivery mechanism.
"""

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class ChatEventEmitter(ABC):
    """Abstract base class for chat event emitters.

    Defines the interface for emitting chat-related events.
    Implementations can choose how to deliver these events
    (WebSocket, no-op, logging, etc.).
    """

    @abstractmethod
    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        """Emit chat:start event."""
        pass

    @abstractmethod
    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Emit chat:chunk event."""
        pass

    @abstractmethod
    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:done event."""
        pass

    @abstractmethod
    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:error event."""
        pass

    @abstractmethod
    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Emit chat:cancelled event."""
        pass

    @abstractmethod
    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        """Emit chat:bot_complete event to user room."""
        pass


class WebSocketEventEmitter(ChatEventEmitter):
    """WebSocket-based event emitter.

    Delegates to the global WebSocket emitter for real-time
    communication with connected clients.
    """

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter:
            await emitter.emit_chat_start(
                task_id=task_id,
                subtask_id=subtask_id,
                message_id=message_id,
                shell_type=shell_type,
            )

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter:
            await emitter.emit_chat_chunk(
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                offset=offset,
                result=result,
            )

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter:
            await emitter.emit_chat_done(
                task_id=task_id,
                subtask_id=subtask_id,
                offset=offset,
                result=result,
                message_id=message_id,
            )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter:
            await emitter.emit_chat_error(
                task_id=task_id,
                subtask_id=subtask_id,
                error=error,
                message_id=message_id,
            )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter:
            await emitter.emit_chat_cancelled(
                task_id=task_id,
                subtask_id=subtask_id,
            )

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        from app.services.chat.ws_emitter import get_ws_emitter

        emitter = get_ws_emitter()
        if emitter:
            await emitter.emit_chat_bot_complete(
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
                content=content,
                result=result,
            )


class NoOpEventEmitter(ChatEventEmitter):
    """No-operation event emitter.

    Used for background tasks that don't have WebSocket connections,
    such as Flow Scheduler triggered tasks. All methods are no-ops
    but log the events for debugging purposes.
    """

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        logger.debug(
            f"[NoOpEmitter] chat:start task={task_id} subtask={subtask_id} "
            f"shell_type={shell_type} (skipped)"
        )

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        # Don't log chunks to avoid spam
        pass

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        logger.debug(
            f"[NoOpEmitter] chat:done task={task_id} subtask={subtask_id} "
            f"offset={offset} (skipped)"
        )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        logger.warning(
            f"[NoOpEmitter] chat:error task={task_id} subtask={subtask_id} "
            f"error={error} (skipped)"
        )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        logger.debug(
            f"[NoOpEmitter] chat:cancelled task={task_id} subtask={subtask_id} (skipped)"
        )

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        logger.debug(
            f"[NoOpEmitter] chat:bot_complete user={user_id} task={task_id} "
            f"subtask={subtask_id} (skipped)"
        )


class SubscriptionEventEmitter(NoOpEventEmitter):
    """Event emitter for Subscription Scheduler tasks.

    Extends NoOpEventEmitter to update BackgroundExecution status when
    chat streaming completes or fails. This ensures Subscription execution
    status is properly tracked even without WebSocket connections.

    Args:
        execution_id: The BackgroundExecution ID to update on completion/error
    """

    def __init__(self, execution_id: int):
        """Initialize SubscriptionEventEmitter.

        Args:
            execution_id: The BackgroundExecution ID to update
        """
        self.execution_id = execution_id

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:done event and update BackgroundExecution status to COMPLETED."""
        logger.info(
            f"[SubscriptionEmitter] chat:done task={task_id} subtask={subtask_id} "
            f"execution_id={self.execution_id}"
        )

        # Update BackgroundExecution status to COMPLETED
        await self._update_execution_status(
            status="COMPLETED",
            result_summary=self._extract_result_summary(result),
        )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:error event and update BackgroundExecution status to FAILED."""
        logger.warning(
            f"[SubscriptionEmitter] chat:error task={task_id} subtask={subtask_id} "
            f"execution_id={self.execution_id} error={error}"
        )

        # Update BackgroundExecution status to FAILED
        await self._update_execution_status(
            status="FAILED",
            error_message=error,
        )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Emit chat:cancelled event and update BackgroundExecution status to CANCELLED."""
        logger.info(
            f"[SubscriptionEmitter] chat:cancelled task={task_id} subtask={subtask_id} "
            f"execution_id={self.execution_id}"
        )

        # Update BackgroundExecution status to CANCELLED
        await self._update_execution_status(status="CANCELLED")

    async def _update_execution_status(
        self,
        status: str,
        result_summary: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """Update BackgroundExecution status in database.

        Args:
            status: New status (COMPLETED, FAILED, CANCELLED)
            result_summary: Optional result summary for COMPLETED status
            error_message: Optional error message for FAILED status
        """
        try:
            from app.db.session import get_db_session
            from app.schemas.subscription import BackgroundExecutionStatus
            from app.services.subscription import subscription_service

            with get_db_session() as db:
                subscription_service.update_execution_status(
                    db,
                    execution_id=self.execution_id,
                    status=BackgroundExecutionStatus(status),
                    result_summary=result_summary,
                    error_message=error_message,
                )
                logger.info(
                    f"[SubscriptionEmitter] Updated execution {self.execution_id} status to {status}"
                )
        except Exception as e:
            logger.error(
                f"[SubscriptionEmitter] Failed to update execution {self.execution_id} "
                f"status to {status}: {e}"
            )

    def _extract_result_summary(
        self, result: Optional[Dict[str, Any]]
    ) -> Optional[str]:
        """Extract a summary from the result dict.

        Args:
            result: The result dictionary from chat completion

        Returns:
            A summary string, or None if no result
        """
        if not result:
            return None

        # Try to get the value from result
        value = result.get("value", "")
        if not value:
            return None

        # Return full content - database column is TEXT type which can store large content
        return value


# Backward compatibility alias
FlowEventEmitter = SubscriptionEventEmitter


# Factory function to get the appropriate emitter
def get_event_emitter(use_websocket: bool = True) -> ChatEventEmitter:
    """Get the appropriate event emitter based on context.

    Args:
        use_websocket: If True, returns WebSocketEventEmitter.
                      If False, returns NoOpEventEmitter.

    Returns:
        ChatEventEmitter instance
    """
    if use_websocket:
        return WebSocketEventEmitter()
    return NoOpEventEmitter()
