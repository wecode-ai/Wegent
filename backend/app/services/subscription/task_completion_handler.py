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

import dataclasses
import logging
from itertools import chain
from typing import Any, Dict, Optional

from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.orm import Session

from app.core.events import TaskCompletedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.schemas.subscription import (
    BackgroundExecutionStatus,
)
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.execution import get_executor_runtime_client
from app.services.subscription.execution import background_execution_manager
from app.services.subscription.helpers import validate_subscription_for_read
from app.services.subscription.notification_directives import (
    strip_notification_directives,
)
from app.services.subscription.notification_dispatcher import (
    subscription_notification_dispatcher,
)
from app.services.subscription.state_machine import is_terminal_state
from app.stores.tasks import subtask_store, task_store

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
                        f"task_id={event.task_id}, checking task auto-delete label"
                    )
                    await self._cleanup_auto_delete_task_executor(db, event)
                    return

                # Skip if already in terminal state
                current_status = BackgroundExecutionStatus(execution.status)
                if is_terminal_state(current_status):
                    logger.info(
                        f"[TaskCompletionHandler] Execution {execution.id} already in "
                        f"terminal state {current_status.value}, skipping update"
                    )
                    # cancel_execution marks the execution CANCELLED before the
                    # executor reports the end of the run, so this event is the
                    # first chance to release the container.
                    if event.status in {"COMPLETED", "FAILED", "CANCELLED"}:
                        await self._cleanup_finished_subscription_executor(
                            db, execution, event.task_id
                        )
                    return

                # Extract result summary from event
                result_summary = self._extract_result_summary(event)
                stored_result_summary = (
                    strip_notification_directives(result_summary)
                    if result_summary
                    else result_summary
                )

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

                updated, status, event, is_silent_exit = self._save_completion_status(
                    db, execution, event, status, stored_result_summary, is_silent_exit
                )

                if not updated:
                    await self._cleanup_after_status_noop(db, execution, event)
                    return

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
                            result_summary=stored_result_summary,
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
                    BackgroundExecutionStatus.FAILED,
                    BackgroundExecutionStatus.CANCELLED,
                ):
                    await self._cleanup_finished_subscription_executor(
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
                ) and not self._is_code_wiki_scheduled_update(db, execution):
                    await self._dispatch_notifications(
                        db, execution, event, result_summary
                    )

        except Exception as e:
            logger.error(
                f"[TaskCompletionHandler] Failed to handle TaskCompletedEvent: "
                f"task_id={event.task_id}, error={e}",
                exc_info=True,
            )

    def _attempt_status_update(
        self, db: Session, **values: Any
    ) -> tuple[bool, bool, Optional[Exception]]:
        """Distinguish this attempt's acknowledged commit from a competing writer."""
        committed = False

        def record_commit(_session: Session) -> None:
            nonlocal committed
            committed = True

        sqlalchemy_event.listen(db, "after_commit", record_commit)
        try:
            updated = self.execution_manager.update_execution_status(db, **values)
            return bool(updated), committed, None
        except Exception as exc:
            return False, committed, exc
        finally:
            sqlalchemy_event.remove(db, "after_commit", record_commit)

    def _save_completion_status(
        self,
        db: Session,
        execution: BackgroundExecution,
        event: TaskCompletedEvent,
        status: BackgroundExecutionStatus,
        result_summary: Optional[str],
        is_silent_exit: bool,
    ) -> tuple[bool, BackgroundExecutionStatus, TaskCompletedEvent, bool]:
        """Reconcile durable writes without repeating counters or another delivery."""
        execution_id = execution.id
        version = getattr(execution, "version", None)
        values = dict(
            execution_id=execution_id,
            expected_version=version,
            status=status,
            result_summary=result_summary,
            error_message=event.error,
            skip_notifications=True,
        )
        updated, committed, exc = self._attempt_status_update(db, **values)
        if exc is None:
            return updated, status, event, is_silent_exit

        db.rollback()
        db.refresh(execution)
        current = BackgroundExecutionStatus(execution.status)
        current_version = getattr(execution, "version", None)
        expected_next = version + 1 if version is not None else None
        if committed:
            if current == status and current_version == expected_next:
                event = dataclasses.replace(
                    event,
                    error=getattr(execution, "error_message", None) or event.error,
                )
                return True, status, event, is_silent_exit
            return False, status, event, is_silent_exit
        if is_terminal_state(current) or current_version != version:
            return False, status, event, is_silent_exit

        logger.error(
            "[TaskCompletionHandler] Could not save the result of execution %s "
            "(result_summary_length=%s)",
            execution_id,
            len(result_summary or ""),
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        cause = getattr(exc, "orig", None) or exc
        error = (
            "The run finished but its result could not be saved: "
            f"{type(cause).__name__}: {str(cause)[:300]}"
        )
        updated, committed, fallback_error = self._attempt_status_update(
            db,
            execution_id=execution_id,
            expected_version=version,
            status=BackgroundExecutionStatus.FAILED,
            error_message=error,
            skip_notifications=True,
        )
        if fallback_error is not None:
            db.rollback()
            db.refresh(execution)
            updated = (
                committed
                and execution.status == BackgroundExecutionStatus.FAILED.value
                and getattr(execution, "version", None) == expected_next
                and execution.error_message == error
            )
            if not updated:
                logger.error(
                    "[TaskCompletionHandler] Failure status could not be saved for %s",
                    execution_id,
                    exc_info=(
                        type(fallback_error),
                        fallback_error,
                        fallback_error.__traceback__,
                    ),
                )
        if not updated:
            return False, status, event, is_silent_exit
        execution.status = BackgroundExecutionStatus.FAILED.value
        return (
            True,
            BackgroundExecutionStatus.FAILED,
            dataclasses.replace(event, status="FAILED", error=error),
            False,
        )

    @staticmethod
    def _is_code_wiki_scheduled_update(
        db: Session, execution: BackgroundExecution
    ) -> bool:
        from app.services.knowledge.code_wiki.scheduled_update import (
            is_code_wiki_scheduled_update,
        )

        subscription = db.get(Kind, execution.subscription_id)
        return bool(subscription and is_code_wiki_scheduled_update(subscription))

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

        if execution is not None:
            return execution

        from app.services.knowledge.code_wiki.subscription_integration import (
            recover_scheduled_execution_for_task,
        )

        return recover_scheduled_execution_for_task(db, task_id)

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

    async def _cleanup_auto_delete_task_executor(
        self,
        db: Session,
        event: TaskCompletedEvent,
    ) -> None:
        """Delete executor runtime for non-subscription tasks with auto-delete enabled."""
        if event.status not in {"COMPLETED", "FAILED", "CANCELLED"}:
            logger.debug(
                "[TaskCompletionHandler] Skip auto-delete for non-terminal task_id=%s status=%s",
                event.task_id,
                event.status,
            )
            return

        task = task_store.get_task_by_states(
            db,
            task_id=event.task_id,
            states=TaskResource.is_active_query(),
        )
        if not task:
            logger.warning(
                "[TaskCompletionHandler] Cannot auto-delete executor: task_id=%s not found",
                event.task_id,
            )
            return

        task_crd = Task.model_validate(task.json)
        labels = task_crd.metadata.labels or {}
        if labels.get("autoDeleteExecutor") != "true":
            logger.debug(
                "[TaskCompletionHandler] Task %s autoDeleteExecutor is not enabled",
                event.task_id,
            )
            return

        await self._cleanup_task_runtime(
            db,
            event.task_id,
            "auto-delete task",
        )

    async def _cleanup_after_status_noop(
        self,
        db: Session,
        execution: BackgroundExecution,
        event: TaskCompletedEvent,
    ) -> None:
        """Leave a competing active run unchanged and clean only a committed terminal run."""
        # End the failed write's REPEATABLE READ snapshot before refreshing.
        db.rollback()
        db.refresh(execution)
        if is_terminal_state(
            BackgroundExecutionStatus(execution.status)
        ) and event.status in {
            "COMPLETED",
            "FAILED",
            "CANCELLED",
        }:
            await self._cleanup_finished_subscription_executor(
                db, execution, event.task_id
            )

    async def _cleanup_finished_subscription_executor(
        self,
        db: Session,
        execution: BackgroundExecution,
        task_id: int,
    ) -> None:
        """Isolate runtime cleanup failures from required result delivery."""
        try:
            await self._delete_finished_subscription_executor(db, execution, task_id)
        except Exception:
            db.rollback()
            logger.exception(
                "[TaskCompletionHandler] Subscription runtime cleanup failed "
                "for task_id=%s; continuing completion handling",
                task_id,
            )

    async def _delete_finished_subscription_executor(
        self,
        db: Session,
        execution: BackgroundExecution,
        task_id: int,
    ) -> None:
        """Delete the executors as soon as a subscription run ends.

        The cleanup applies whatever the outcome was: a finished run never
        reuses its container (each run gets a new task), so keeping it only
        holds a node slot. Cleanup is idempotent: once the subtasks are marked
        executor_deleted_at, the runtime lookup finds nothing and returns.
        """
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

        await self._cleanup_task_runtime(
            db,
            task_id,
            f"subscription {execution.subscription_id}",
        )

    _cleanup_completed_managed_subscription_executor = (
        _cleanup_finished_subscription_executor
    )

    async def _cleanup_task_runtime(
        self,
        db: Session,
        task_id: int,
        cleanup_source: str,
    ) -> None:
        """Delete sandbox or executor runtime for a completed task."""
        task = task_store.get_task_by_states(
            db,
            task_id=task_id,
            states=TaskResource.is_active_query(),
        )
        if not task:
            logger.warning(
                "[TaskCompletionHandler] Cannot clean runtime for %s: task_id=%s not found",
                cleanup_source,
                task_id,
            )
            return

        subtasks = subtask_store.iter_runtime_cleanup_rows(
            db,
            task_id=task_id,
            owner_user_id=task.user_id,
        )
        first = next(subtasks, None)
        if first is None:
            logger.info(
                "[TaskCompletionHandler] No undeleted subtasks found for %s task_id=%s",
                cleanup_source,
                task_id,
            )
            return

        owner_user_id = task.user_id
        prepared_bindings = {
            subtask.id: (subtask.executor_namespace, subtask.executor_name)
            for subtask in chain([first], subtasks)
        }
        successful_keys = set()
        unique_executors = {
            ((namespace or ""), name)
            for namespace, name in prepared_bindings.values()
            if name
        }

        # All HTTP inputs are scalars; no ORM reload may reacquire this connection.
        db.commit()

        runtime_client = get_executor_runtime_client()
        sandbox_payload, sandbox_lookup_error = await runtime_client.get_sandbox(
            str(task_id)
        )
        cleanup_mode = "sandbox" if sandbox_payload is not None else "executor"
        if sandbox_lookup_error:
            cleanup_mode = "fallback"
        logger.info(
            "[TaskCompletionHandler] Immediate runtime cleanup mode resolved for %s task_id=%s mode=%s sandbox_lookup_error=%s",
            cleanup_source,
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
                    "[TaskCompletionHandler] Immediate sandbox cleanup succeeded for %s task_id=%s",
                    cleanup_source,
                    task_id,
                )
            else:
                logger.info(
                    "[TaskCompletionHandler] Immediate sandbox cleanup skipped or failed for %s task_id=%s error=%s",
                    cleanup_source,
                    task_id,
                    sandbox_error,
                )

        if cleanup_mode in {"executor", "fallback"}:
            if not unique_executors:
                logger.info(
                    "[TaskCompletionHandler] No executor-backed subtasks found for %s task_id=%s",
                    cleanup_source,
                    task_id,
                )
            else:
                logger.info(
                    "[TaskCompletionHandler] Attempting immediate executor cleanup for %s task_id=%s executors=%s",
                    cleanup_source,
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
                            "[TaskCompletionHandler] Failed to delete executor for %s: %s/%s: %s",
                            cleanup_source,
                            executor_namespace,
                            executor_name,
                            exc,
                        )

        if not successful_keys and not sandbox_deleted:
            logger.warning(
                "[TaskCompletionHandler] Immediate runtime cleanup finished without successful deletions for %s task_id=%s mode=%s",
                cleanup_source,
                task_id,
                cleanup_mode,
            )
            return

        successful_bindings = {
            subtask_id: (namespace, name)
            for subtask_id, (namespace, name) in prepared_bindings.items()
            if sandbox_deleted or ((namespace or ""), name) in successful_keys
        }
        subtask_store.mark_runtime_cleanup_deleted(
            db,
            task_id=task_id,
            owner_user_id=owner_user_id,
            bindings=successful_bindings,
        )

        db.commit()
        logger.info(
            "[TaskCompletionHandler] Immediate executor cleanup succeeded for %s task_id=%s deleted_executors=%s sandbox_deleted=%s",
            cleanup_source,
            task_id,
            sorted(successful_keys),
            sandbox_deleted,
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

            # Keep partial output in execution history, but report the failure cause.
            notification_summary = result_summary or ""
            if execution.status == BackgroundExecutionStatus.FAILED.value:
                notification_summary = (
                    event.error or ""
                ).strip() or "Execution failed; no error details were provided."

            # Dispatch follower notifications (via Messager channels)
            await subscription_notification_dispatcher.dispatch_execution_notifications(
                db,
                subscription_id=execution.subscription_id,
                execution_id=execution.id,
                subscription_display_name=subscription_display_name,
                result_summary=notification_summary,
                status=execution.status,
                detail_url=None,  # Could be added if needed
            )
            # Dispatch webhook notifications (configured on subscription)
            # Title is the subscription display name
            if subscription_crd.spec.notificationWebhooks:
                await subscription_notification_dispatcher.dispatch_webhook_notifications(
                    webhooks=subscription_crd.spec.notificationWebhooks,
                    subscription_display_name=subscription_display_name,
                    result_summary=notification_summary,
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
