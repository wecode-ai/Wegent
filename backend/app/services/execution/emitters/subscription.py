# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription result emitter.

Emits execution events and updates BackgroundExecution status for subscription tasks.
This emitter is used by the subscription scheduler to track execution progress.
"""

import logging
from typing import Any, Callable, Coroutine, Optional

from shared.models import EventType, ExecutionEvent

from .base import BaseResultEmitter

logger = logging.getLogger(__name__)


class SubscriptionResultEmitter(BaseResultEmitter):
    """Result emitter for subscription tasks.

    Updates BackgroundExecution status when execution completes or fails.
    This emitter is designed to work with both SSE (Chat Shell) and
    HTTP+Callback (executor_manager) modes.

    For SSE mode:
    - Events are received directly from the SSE stream
    - Status is updated immediately when DONE/ERROR events are received

    For HTTP+Callback mode:
    - This emitter is not used directly for event emission
    - Status updates come through the /internal/callback API
    - The callback handler updates BackgroundExecution status
    """

    def __init__(
        self,
        task_id: int,
        subtask_id: int,
        execution_id: int,
        on_status_changed: Optional[
            Callable[[str, str, bool], Coroutine[Any, Any, None]]
        ] = None,
    ):
        """Initialize the subscription result emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            execution_id: BackgroundExecution ID to update
            on_status_changed: Optional async callback for status changes.
                Signature: async def callback(status: str, result_summary: str, is_silent_exit: bool)
        """
        super().__init__(task_id, subtask_id)
        self.execution_id = execution_id
        self.on_status_changed = on_status_changed
        self._accumulated_content = ""

    async def emit(self, event: ExecutionEvent) -> None:
        """Process execution event and update status if terminal.

        Args:
            event: Execution event to process
        """
        if self._closed:
            logger.warning("[SubscriptionResultEmitter] Emitter closed, dropping event")
            return

        # Accumulate content from CHUNK events
        if event.type == EventType.CHUNK:
            self._accumulated_content += event.content or ""
            return

        # Handle terminal events
        if event.type == EventType.DONE:
            await self._handle_done(event)
        elif event.type == EventType.ERROR:
            await self._handle_error(event)
        elif event.type == EventType.CANCELLED:
            await self._handle_cancelled()

    async def _handle_done(self, event: ExecutionEvent) -> None:
        """Handle DONE event - update status to COMPLETED.

        Args:
            event: The DONE event
        """
        from app.services.subscription.helpers import extract_result_summary

        logger.info(
            f"[SubscriptionResultEmitter] DONE event received: "
            f"execution_id={self.execution_id}, task_id={self.task_id}"
        )

        # Check for silent exit flag
        is_silent_exit = False
        if event.result and isinstance(event.result, dict):
            is_silent_exit = event.result.get("silent_exit", False)

        # Also check subtask's result in database
        if not is_silent_exit:
            is_silent_exit = await self._check_subtask_silent_exit()

        status = "COMPLETED_SILENT" if is_silent_exit else "COMPLETED"

        if is_silent_exit:
            logger.info(
                f"[SubscriptionResultEmitter] Silent exit detected for "
                f"execution {self.execution_id}"
            )

        # Extract result summary
        result_summary = extract_result_summary(event.result)
        if not result_summary and self._accumulated_content:
            # Use accumulated content as summary if no result provided
            result_summary = self._accumulated_content[:500]
            if len(self._accumulated_content) > 500:
                result_summary += "..."

        # Update BackgroundExecution status
        await self._update_execution_status(
            status=status,
            result_summary=result_summary,
        )

        # Call the callback if provided
        if self.on_status_changed:
            try:
                await self.on_status_changed(status, result_summary, is_silent_exit)
            except Exception as e:
                logger.error(
                    f"[SubscriptionResultEmitter] Status change callback failed: {e}"
                )

    async def _handle_error(self, event: ExecutionEvent) -> None:
        """Handle ERROR event - update status to FAILED.

        Args:
            event: The ERROR event
        """
        error_message = event.error or "Unknown error"
        logger.warning(
            f"[SubscriptionResultEmitter] ERROR event received: "
            f"execution_id={self.execution_id}, error={error_message}"
        )

        # Update BackgroundExecution status
        await self._update_execution_status(
            status="FAILED",
            error_message=error_message,
        )

        # Call the callback if provided
        if self.on_status_changed:
            try:
                await self.on_status_changed(
                    "FAILED", f"Task failed: {error_message}", False
                )
            except Exception as e:
                logger.error(
                    f"[SubscriptionResultEmitter] Status change callback failed: {e}"
                )

    async def _handle_cancelled(self) -> None:
        """Handle CANCELLED event - update status to CANCELLED."""
        logger.info(
            f"[SubscriptionResultEmitter] CANCELLED event received: "
            f"execution_id={self.execution_id}"
        )

        # Update BackgroundExecution status
        await self._update_execution_status(status="CANCELLED")

    async def _check_subtask_silent_exit(self) -> bool:
        """Check if subtask has silent_exit flag set in its result.

        Returns:
            True if subtask has silent_exit=True in its result
        """
        try:
            from app.db.session import get_db_session
            from app.models.subtask import Subtask

            with get_db_session() as db:
                subtask = (
                    db.query(Subtask).filter(Subtask.id == self.subtask_id).first()
                )
                if subtask and subtask.result and isinstance(subtask.result, dict):
                    is_silent = subtask.result.get("silent_exit", False)
                    if is_silent:
                        logger.info(
                            f"[SubscriptionResultEmitter] Found silent_exit flag "
                            f"in subtask {self.subtask_id} result"
                        )
                    return is_silent
        except Exception as e:
            logger.error(
                f"[SubscriptionResultEmitter] Failed to check subtask "
                f"{self.subtask_id} silent_exit: {e}"
            )
        return False

    async def _update_execution_status(
        self,
        status: str,
        result_summary: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """Update BackgroundExecution status in database.

        Args:
            status: New status (COMPLETED, COMPLETED_SILENT, FAILED, CANCELLED)
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
                    # Skip notifications here - they are dispatched by the callback
                    skip_notifications=True,
                )
                logger.info(
                    f"[SubscriptionResultEmitter] Updated execution "
                    f"{self.execution_id} status to {status}"
                )
        except Exception as e:
            logger.error(
                f"[SubscriptionResultEmitter] Failed to update execution "
                f"{self.execution_id} status to {status}: {e}"
            )

    async def close(self) -> None:
        """Close the emitter."""
        await super().close()
        logger.debug(
            f"[SubscriptionResultEmitter] Closed emitter for "
            f"execution {self.execution_id}"
        )
