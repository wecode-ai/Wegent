# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task completion handler for subscription executions.

This module handles TaskCompletedEvent from the event bus and updates
BackgroundExecution records accordingly. It provides a unified way to
handle task completion across all execution modes (SSE, HTTP+Callback, etc.).

Usage:
    # Register handler on application startup
    from app.core.events import event_bus
    from app.services.subscription.task_completion_handler import (
        SubscriptionTaskCompletionHandler,
    )

    handler = SubscriptionTaskCompletionHandler()
    event_bus.subscribe(TaskCompletedEvent, handler.on_task_completed)
"""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.events import TaskCompletedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.subtask import Subtask
from app.schemas.subscription import (
    BackgroundExecutionStatus,
)
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.execution import get_executor_runtime_client
from app.services.subscription.execution import background_execution_manager
from app.services.subscription.helpers import validate_subscription_for_read
from app.services.subscription.notification_dispatcher import (
    subscription_notification_dispatcher,
)
from app.services.subscription.state_machine import is_terminal_state

logger = logging.getLogger(__name__)


class SubscriptionTaskCompletionHandler:
    """Handler for TaskCompletedEvent to update subscription executions.

    This class receives TaskCompletedEvent from the event bus and:
    1. Finds the associated BackgroundExecution by task_id
    2. Updates the execution status and result_summary
    3. Dispatches notifications to followers
    """

    def __init__(self):
        """Initialize the handler."""
        self.execution_manager = background_execution_manager

    async def on_task_completed(self, event: TaskCompletedEvent) -> None:
        """Handle TaskCompletedEvent.

        This method is called by the event bus when a task completes.
        It finds the associated BackgroundExecution and updates its status.

        Args:
            event: TaskCompletedEvent containing task_id, subtask_id, status, result
        """
        logger.info(
            f"[TaskCompletionHandler] Received TaskCompletedEvent: "
            f"task_id={event.task_id}, subtask_id={event.subtask_id}, "
            f"status={event.status}"
        )

        try:
            with get_db_session() as db:
                # Find BackgroundExecution by task_id
                execution = self._find_execution_by_task_id(db, event.task_id)

                if not execution:
                    logger.debug(
                        f"[TaskCompletionHandler] No BackgroundExecution found for "
                        f"task_id={event.task_id}, this is not a subscription task"
                    )
                    return

                # Skip if already in terminal state
                current_status = BackgroundExecutionStatus(execution.status)
                if is_terminal_state(current_status):
                    logger.info(
                        f"[TaskCompletionHandler] Execution {execution.id} already in "
                        f"terminal state {current_status.value}, skipping update"
                    )
                    return

                # Extract result summary from event
                result_summary = self._extract_result_summary(event)

                # Check if this is a silent exit BEFORE mapping status
                is_silent_exit = self._is_silent_exit(event)

                # Map event status to BackgroundExecutionStatus
                # Use COMPLETED_SILENT for silent exits
                if is_silent_exit and event.status == "COMPLETED":
                    status = BackgroundExecutionStatus.COMPLETED_SILENT
                else:
                    status = self._map_status(event.status)

                # Update execution status
                logger.info(
                    f"[TaskCompletionHandler] Updating execution {execution.id}: "
                    f"status={status.value}, result_summary_length={len(result_summary or '')}, "
                    f"is_silent_exit={is_silent_exit}"
                )

                self.execution_manager.update_execution_status(
                    db,
                    execution_id=execution.id,
                    status=status,
                    result_summary=result_summary,
                    error_message=event.error,
                    skip_notifications=True,  # We'll handle notifications separately
                )

                # Write back result to inbox message if this is an inbox-triggered execution
                # inbox_message_id is NOT NULL DEFAULT 0; 0 means no inbox message
                if getattr(execution, "inbox_message_id", 0) > 0:
                    try:
                        from app.services.inbox.result_writeback import (
                            write_execution_result_to_message,
                        )

                        write_execution_result_to_message(
                            db,
                            inbox_message_id=execution.inbox_message_id,
                            status=event.status,
                            result_summary=result_summary,
                            error_message=event.error,
                            task_id=event.task_id,
                        )
                    except Exception as wb_err:
                        logger.error(
                            f"[TaskCompletionHandler] Failed to write back "
                            f"inbox result for message {execution.inbox_message_id}: "
                            f"{wb_err}",
                            exc_info=True,
                        )

                if status in (
                    BackgroundExecutionStatus.COMPLETED,
                    BackgroundExecutionStatus.COMPLETED_SILENT,
                ):
                    await self._cleanup_completed_managed_subscription_executor(
                        db, execution, event.task_id
                    )

                # Skip notifications for silent exits
                if is_silent_exit:
                    logger.info(
                        f"[TaskCompletionHandler] Silent exit detected for execution "
                        f"{execution.id}, status set to COMPLETED_SILENT, skipping notifications"
                    )
                    return

                # Dispatch notifications for terminal states
                if status in (
                    BackgroundExecutionStatus.COMPLETED,
                    BackgroundExecutionStatus.FAILED,
                ):
                    await self._dispatch_notifications(
                        db, execution, event, result_summary
                    )

        except Exception as e:
            logger.error(
                f"[TaskCompletionHandler] Failed to handle TaskCompletedEvent: "
                f"task_id={event.task_id}, error={e}",
                exc_info=True,
            )

    def _find_execution_by_task_id(
        self, db: Session, task_id: int
    ) -> Optional[BackgroundExecution]:
        """Find BackgroundExecution by associated task_id.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            BackgroundExecution if found, None otherwise
        """
        # Get the most recent execution for this task
        # that is not in a terminal state
        execution = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.task_id == task_id,
                BackgroundExecution.status.in_(
                    [
                        BackgroundExecutionStatus.PENDING.value,
                        BackgroundExecutionStatus.RUNNING.value,
                    ]
                ),
            )
            .order_by(BackgroundExecution.id.desc())
            .first()
        )

        if execution:
            return execution

        # If no running execution found, try to get the most recent one
        # (for cases where the event arrives after status was already updated)
        execution = (
            db.query(BackgroundExecution)
            .filter(BackgroundExecution.task_id == task_id)
            .order_by(BackgroundExecution.id.desc())
            .first()
        )

        return execution

    def _extract_result_summary(self, event: TaskCompletedEvent) -> Optional[str]:
        """Extract result summary from TaskCompletedEvent.

        Args:
            event: TaskCompletedEvent

        Returns:
            Result summary string or None
        """
        if not event.result or not isinstance(event.result, dict):
            return None

        from app.services.subscription.helpers import extract_result_summary

        return extract_result_summary(event.result)

    def _map_status(self, event_status: str) -> BackgroundExecutionStatus:
        """Map event status to BackgroundExecutionStatus.

        Args:
            event_status: Status from TaskCompletedEvent

        Returns:
            BackgroundExecutionStatus
        """
        status_map = {
            "COMPLETED": BackgroundExecutionStatus.COMPLETED,
            "FAILED": BackgroundExecutionStatus.FAILED,
            "CANCELLED": BackgroundExecutionStatus.CANCELLED,
        }
        return status_map.get(event_status, BackgroundExecutionStatus.FAILED)

    def _is_silent_exit(self, event: TaskCompletedEvent) -> bool:
        """Check if the task completed with a silent exit.

        Silent exit is indicated by the silent_exit flag in the result dict,
        which is set by the MCP silent_exit tool.

        Args:
            event: TaskCompletedEvent

        Returns:
            True if this is a silent exit, False otherwise
        """
        if not event.result or not isinstance(event.result, dict):
            return False

        return event.result.get("silent_exit", False) is True

    async def _cleanup_completed_managed_subscription_executor(
        self,
        db: Session,
        execution: BackgroundExecution,
        task_id: int,
    ) -> None:
        """Delete executors immediately for completed subscription tasks."""
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == execution.subscription_id,
                Kind.kind == "Subscription",
            )
            .first()
        )

        if not subscription:
            logger.warning(
                "[TaskCompletionHandler] Cannot clean executor: subscription %s not found",
                execution.subscription_id,
            )
            return

        subscription_crd = validate_subscription_for_read(subscription.json)
        execution_target = getattr(subscription_crd.spec, "executionTarget", None)
        logger.info(
            "[TaskCompletionHandler] Cleaning executors for subscription %s task_id=%s execution_target=%s",
            execution.subscription_id,
            task_id,
            getattr(execution_target, "type", None),
        )

        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.executor_deleted_at == False,
            )
            .all()
        )
        if not subtasks:
            logger.info(
                "[TaskCompletionHandler] No undeleted subtasks found for subscription %s task_id=%s",
                execution.subscription_id,
                task_id,
            )
            return

        executor_subtasks = [subtask for subtask in subtasks if subtask.executor_name]
        successful_keys = set()
        unique_executors = {
            ((subtask.executor_namespace or ""), subtask.executor_name)
            for subtask in executor_subtasks
            if subtask.executor_name
        }

        runtime_client = get_executor_runtime_client()
        sandbox_payload, sandbox_lookup_error = await runtime_client.get_sandbox(
            str(task_id)
        )
        cleanup_mode = "sandbox" if sandbox_payload is not None else "executor"
        if sandbox_lookup_error:
            cleanup_mode = "fallback"
        logger.info(
            "[TaskCompletionHandler] Immediate runtime cleanup mode resolved for subscription %s task_id=%s mode=%s sandbox_lookup_error=%s",
            execution.subscription_id,
            task_id,
            cleanup_mode,
            sandbox_lookup_error,
        )

        sandbox_deleted = False
        if cleanup_mode in {"sandbox", "fallback"}:
            sandbox_deleted, sandbox_error = await runtime_client.delete_sandbox(
                str(task_id)
            )
            if sandbox_deleted:
                logger.info(
                    "[TaskCompletionHandler] Immediate sandbox cleanup succeeded for subscription %s task_id=%s",
                    execution.subscription_id,
                    task_id,
                )
            else:
                logger.info(
                    "[TaskCompletionHandler] Immediate sandbox cleanup skipped or failed for subscription %s task_id=%s error=%s",
                    execution.subscription_id,
                    task_id,
                    sandbox_error,
                )

        if cleanup_mode in {"executor", "fallback"}:
            if not unique_executors:
                logger.info(
                    "[TaskCompletionHandler] No executor-backed subtasks found for subscription %s task_id=%s",
                    execution.subscription_id,
                    task_id,
                )
            else:
                logger.info(
                    "[TaskCompletionHandler] Attempting immediate executor cleanup for subscription %s task_id=%s executors=%s",
                    execution.subscription_id,
                    task_id,
                    sorted(unique_executors),
                )

                for executor_namespace, executor_name in unique_executors:
                    try:
                        await executor_kinds_service.delete_executor_task_async(
                            executor_name,
                            executor_namespace,
                        )
                        successful_keys.add((executor_namespace, executor_name))
                    except Exception as exc:
                        logger.warning(
                            "[TaskCompletionHandler] Failed to delete executor for subscription %s: %s/%s: %s",
                            execution.subscription_id,
                            executor_namespace,
                            executor_name,
                            exc,
                        )

        if not successful_keys and not sandbox_deleted:
            logger.warning(
                "[TaskCompletionHandler] Immediate runtime cleanup finished without successful deletions for subscription %s task_id=%s mode=%s",
                execution.subscription_id,
                task_id,
                cleanup_mode,
            )
            return

        for subtask in subtasks:
            executor_key = ((subtask.executor_namespace or ""), subtask.executor_name)
            if sandbox_deleted or executor_key in successful_keys:
                subtask.executor_deleted_at = True

        db.commit()
        logger.info(
            "[TaskCompletionHandler] Immediate executor cleanup succeeded for subscription %s task_id=%s deleted_executors=%s",
            execution.subscription_id,
            task_id,
            sorted(successful_keys),
        )

    async def _dispatch_notifications(
        self,
        db: Session,
        execution: BackgroundExecution,
        event: TaskCompletedEvent,
        result_summary: Optional[str],
    ) -> None:
        """Dispatch notifications for completed execution.

        Args:
            db: Database session
            execution: BackgroundExecution record
            event: TaskCompletedEvent
            result_summary: Extracted result summary
        """
        try:
            # Get subscription info
            subscription = (
                db.query(Kind)
                .filter(
                    Kind.id == execution.subscription_id,
                    Kind.kind == "Subscription",
                    Kind.is_active == True,
                )
                .first()
            )

            if not subscription:
                logger.warning(
                    f"[TaskCompletionHandler] Subscription {execution.subscription_id} not found"
                )
                return

            # Get display names
            from app.schemas.kind import Team

            subscription_crd = validate_subscription_for_read(subscription.json)
            subscription_display_name = (
                subscription_crd.spec.displayName or subscription.name
            )

            # Get team display name
            team_display_name = None
            if subscription_crd.spec.teamRef:
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.name == subscription_crd.spec.teamRef.name,
                        Kind.namespace == subscription_crd.spec.teamRef.namespace,
                        Kind.kind == "Team",
                        Kind.is_active == True,
                    )
                    .first()
                )
                if team:
                    try:
                        team_crd = Team.model_validate(team.json)
                        team_display_name = (
                            team_crd.spec.displayName if team_crd.spec else None
                        ) or team.name
                    except Exception:
                        team_display_name = team.name

            # Build subscription info string
            subscription_info = subscription_display_name
            if team_display_name:
                subscription_info = f"{subscription_info} ({team_display_name})"

            # Dispatch follower notifications (via Messager channels)
            await subscription_notification_dispatcher.dispatch_execution_notifications(
                db,
                subscription_id=execution.subscription_id,
                execution_id=execution.id,
                subscription_display_name=subscription_display_name,
                result_summary=result_summary or "",
                status=execution.status,
                detail_url=None,  # Could be added if needed
            )
            # Dispatch webhook notifications (configured on subscription)
            # Title is the subscription display name
            if subscription_crd.spec.notificationWebhooks:
                await subscription_notification_dispatcher.dispatch_webhook_notifications(
                    webhooks=subscription_crd.spec.notificationWebhooks,
                    subscription_display_name=subscription_display_name,
                    result_summary=result_summary or "",
                    status=execution.status,
                    execution_id=execution.id,
                    detail_url=None,
                )

            logger.info(
                f"[TaskCompletionHandler] Notifications dispatched for "
                f"execution {execution.id}"
            )
        except Exception as e:
            logger.error(
                f"[TaskCompletionHandler] Failed to dispatch notifications for "
                f"execution {execution.id}: {e}",
                exc_info=True,
            )

    def _format_result_summary(
        self, prompt: Optional[str], ai_result: Optional[str], status: str
    ) -> str:
        """Format result summary for notification.

        Args:
            prompt: The trigger prompt
            ai_result: The AI response
            status: Execution status

        Returns:
            Formatted summary string
        """
        # Add trigger reason if available
        trigger_info = ""
        if prompt:
            trigger_text = prompt[:200] + "..." if len(prompt) > 200 else prompt
            trigger_info = f"触发内容: {trigger_text}\n\n"

        # Format based on status
        if status == BackgroundExecutionStatus.FAILED.value:
            return f"{trigger_info}执行失败"

        # Get AI response preview
        ai_summary = self._extract_ai_summary(ai_result)
        return f"{trigger_info}回复内容: {ai_summary}"

    def _extract_ai_summary(self, ai_result: Optional[str]) -> str:
        """Extract a concise summary from AI response.

        Args:
            ai_result: The raw AI response

        Returns:
            Concise summary (up to 200 chars)
        """
        if not ai_result:
            return "无回复内容"

        result = ai_result.strip()

        if len(result) <= 200:
            return result

        preview = result[:200]

        # Try to find a sentence boundary
        import re

        last_boundary = -1
        for match in re.finditer(r"[.!?。！？]\s", preview):
            last_boundary = match.end()

        if last_boundary > 50:
            return preview[:last_boundary] + "..."

        # Try to find a word boundary
        last_space = preview.rfind(" ", 150, 200)
        if last_space > 0:
            return preview[:last_space] + "..."

        return preview + "..."


# Singleton instance
task_completion_handler = SubscriptionTaskCompletionHandler()


async def handle_task_completed(event: TaskCompletedEvent) -> None:
    """Global handler function for TaskCompletedEvent.

    This function is used to subscribe to the event bus.
    It delegates to the singleton handler instance.

    Args:
        event: TaskCompletedEvent
    """
    await task_completion_handler.on_task_completed(event)
