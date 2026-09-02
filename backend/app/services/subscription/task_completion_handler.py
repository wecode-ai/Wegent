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
from dataclasses import dataclass
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.events import TaskCompletedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.models.task import TaskResource
from app.schemas.kind import Task
from app.schemas.subscription import (
    BackgroundExecutionStatus,
    NotificationWebhook,
)
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution import get_executor_runtime_client
from app.services.subscription.execution import background_execution_manager
from app.services.subscription.helpers import validate_subscription_for_read
from app.services.subscription.notification_dispatcher import (
    subscription_notification_dispatcher,
)
from app.services.subscription.state_machine import is_terminal_state
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _RuntimeSubtask:
    subtask_id: int
    executor_name: Optional[str]
    executor_namespace: str


@dataclass(frozen=True)
class _RuntimeCleanupPlan:
    task_id: int
    cleanup_source: str
    subtasks: tuple[_RuntimeSubtask, ...]


@dataclass(frozen=True)
class _RuntimeCleanupOutcome:
    sandbox_deleted: bool
    deleted_executors: frozenset[tuple[str, str]]


@dataclass(frozen=True)
class _NotificationIntent:
    subscription_id: int
    execution_id: int
    result_summary: Optional[str]
    execution_status: str


@dataclass(frozen=True)
class _NotificationContext:
    subscription_display_name: str
    webhooks: tuple[NotificationWebhook, ...]


@dataclass(frozen=True)
class _TaskCompletionPlan:
    cleanup: Optional[_RuntimeCleanupPlan] = None
    notification: Optional[_NotificationIntent] = None


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
        """Persist completion, clean runtimes, and notify without blocking."""
        logger.info(
            f"[TaskCompletionHandler] Received TaskCompletedEvent: "
            f"task_id={event.task_id}, subtask_id={event.subtask_id}, "
            f"status={event.status}"
        )

        try:
            plan = await run_sync_in_executor(
                self._prepare_task_completion_sync,
                event,
            )
            if plan.cleanup is not None:
                await self._execute_runtime_cleanup(plan.cleanup)
            if plan.notification is not None:
                await self._dispatch_notifications(plan.notification)
        except Exception as e:
            logger.error(
                f"[TaskCompletionHandler] Failed to handle TaskCompletedEvent: "
                f"task_id={event.task_id}, error={e}",
                exc_info=True,
            )

    def _prepare_task_completion_sync(
        self,
        event: TaskCompletedEvent,
    ) -> _TaskCompletionPlan:
        """Persist terminal state and return detached follow-up work."""
        with get_db_session() as db:
            execution = self._find_execution_by_task_id(db, event.task_id)
            if not execution:
                logger.debug(
                    "[TaskCompletionHandler] No BackgroundExecution found for "
                    "task_id=%s, checking task auto-delete label",
                    event.task_id,
                )
                return _TaskCompletionPlan(
                    cleanup=self._prepare_auto_delete_cleanup_sync(db, event)
                )

            current_status = BackgroundExecutionStatus(execution.status)
            if is_terminal_state(current_status):
                logger.info(
                    "[TaskCompletionHandler] Execution %s already in terminal "
                    "state %s, skipping update",
                    execution.id,
                    current_status.value,
                )
                return _TaskCompletionPlan()

            result_summary = self._extract_result_summary(event)
            is_silent_exit = self._is_silent_exit(event)
            status = (
                BackgroundExecutionStatus.COMPLETED_SILENT
                if is_silent_exit and event.status == "COMPLETED"
                else self._map_status(event.status)
            )
            logger.info(
                "[TaskCompletionHandler] Updating execution %s: status=%s, "
                "result_summary_length=%s, is_silent_exit=%s",
                execution.id,
                status.value,
                len(result_summary or ""),
                is_silent_exit,
            )
            self.execution_manager.update_execution_status(
                db,
                execution_id=execution.id,
                status=status,
                result_summary=result_summary,
                error_message=event.error,
            )
            self._write_inbox_result_sync(db, execution, event, result_summary)

            cleanup = None
            if status in (
                BackgroundExecutionStatus.COMPLETED,
                BackgroundExecutionStatus.COMPLETED_SILENT,
            ):
                cleanup = self._prepare_completed_cleanup_sync(
                    db,
                    execution,
                    event.task_id,
                )

            notification = None
            if is_silent_exit:
                logger.info(
                    "[TaskCompletionHandler] Silent exit detected for execution "
                    "%s, status set to COMPLETED_SILENT, skipping notifications",
                    execution.id,
                )
            elif status in (
                BackgroundExecutionStatus.COMPLETED,
                BackgroundExecutionStatus.FAILED,
            ):
                notification = _NotificationIntent(
                    subscription_id=execution.subscription_id,
                    execution_id=execution.id,
                    result_summary=result_summary,
                    execution_status=status.value,
                )

            return _TaskCompletionPlan(
                cleanup=cleanup,
                notification=notification,
            )

    def _write_inbox_result_sync(
        self,
        db: Session,
        execution: BackgroundExecution,
        event: TaskCompletedEvent,
        result_summary: Optional[str],
    ) -> None:
        """Write an inbox-linked result within the active worker session."""
        if getattr(execution, "inbox_message_id", 0) <= 0:
            return
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
        except Exception as exc:
            logger.error(
                "[TaskCompletionHandler] Failed to write back inbox result for "
                "message %s: %s",
                execution.inbox_message_id,
                exc,
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

    def _prepare_auto_delete_cleanup_sync(
        self,
        db: Session,
        event: TaskCompletedEvent,
    ) -> Optional[_RuntimeCleanupPlan]:
        """Prepare runtime cleanup for an auto-delete task."""
        if event.status not in {"COMPLETED", "FAILED", "CANCELLED"}:
            logger.debug(
                "[TaskCompletionHandler] Skip auto-delete for non-terminal task_id=%s status=%s",
                event.task_id,
                event.status,
            )
            return None

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
            return None

        task_crd = Task.model_validate(task.json)
        labels = task_crd.metadata.labels or {}
        if labels.get("autoDeleteExecutor") != "true":
            logger.debug(
                "[TaskCompletionHandler] Task %s autoDeleteExecutor is not enabled",
                event.task_id,
            )
            return None

        return self._build_runtime_cleanup_plan_sync(
            db,
            event.task_id,
            "auto-delete task",
        )

    def _prepare_completed_cleanup_sync(
        self,
        db: Session,
        execution: BackgroundExecution,
        task_id: int,
    ) -> Optional[_RuntimeCleanupPlan]:
        """Prepare runtime cleanup for a completed subscription task."""
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
            return None

        subscription_crd = validate_subscription_for_read(subscription.json)
        execution_target = getattr(subscription_crd.spec, "executionTarget", None)
        logger.info(
            "[TaskCompletionHandler] Cleaning executors for subscription %s task_id=%s execution_target=%s",
            execution.subscription_id,
            task_id,
            getattr(execution_target, "type", None),
        )

        return self._build_runtime_cleanup_plan_sync(
            db,
            task_id,
            f"subscription {execution.subscription_id}",
        )

    def _build_runtime_cleanup_plan_sync(
        self,
        db: Session,
        task_id: int,
        cleanup_source: str,
    ) -> Optional[_RuntimeCleanupPlan]:
        """Load runtime cleanup inputs while the worker session is active."""
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
            return None

        subtasks = subtask_store.list_not_executor_deleted_by_task(
            db,
            task_id=task_id,
            owner_user_id=task.user_id,
        )
        if not subtasks:
            logger.info(
                "[TaskCompletionHandler] No undeleted subtasks found for %s task_id=%s",
                cleanup_source,
                task_id,
            )
            return None

        return _RuntimeCleanupPlan(
            task_id=task_id,
            cleanup_source=cleanup_source,
            subtasks=tuple(
                _RuntimeSubtask(
                    subtask_id=subtask.id,
                    executor_name=subtask.executor_name,
                    executor_namespace=subtask.executor_namespace or "",
                )
                for subtask in subtasks
            ),
        )

    async def _execute_runtime_cleanup(self, plan: _RuntimeCleanupPlan) -> None:
        """Delete runtime asynchronously and persist the detached outcome."""
        executor_subtasks = [
            subtask for subtask in plan.subtasks if subtask.executor_name
        ]
        successful_keys: set[tuple[str, str]] = set()
        unique_executors = {
            (subtask.executor_namespace, subtask.executor_name)
            for subtask in executor_subtasks
            if subtask.executor_name
        }

        runtime_client = get_executor_runtime_client()
        sandbox_payload, sandbox_lookup_error = await runtime_client.get_sandbox(
            str(plan.task_id)
        )
        cleanup_mode = "sandbox" if sandbox_payload is not None else "executor"
        if sandbox_lookup_error:
            cleanup_mode = "fallback"
        logger.info(
            "[TaskCompletionHandler] Immediate runtime cleanup mode resolved for %s task_id=%s mode=%s sandbox_lookup_error=%s",
            plan.cleanup_source,
            plan.task_id,
            cleanup_mode,
            sandbox_lookup_error,
        )

        sandbox_deleted = False
        if cleanup_mode in {"sandbox", "fallback"}:
            sandbox_deleted, sandbox_error = await runtime_client.delete_sandbox(
                str(plan.task_id)
            )
            if sandbox_deleted:
                logger.info(
                    "[TaskCompletionHandler] Immediate sandbox cleanup succeeded for %s task_id=%s",
                    plan.cleanup_source,
                    plan.task_id,
                )
            else:
                logger.info(
                    "[TaskCompletionHandler] Immediate sandbox cleanup skipped or failed for %s task_id=%s error=%s",
                    plan.cleanup_source,
                    plan.task_id,
                    sandbox_error,
                )

        if cleanup_mode in {"executor", "fallback"}:
            if not unique_executors:
                logger.info(
                    "[TaskCompletionHandler] No executor-backed subtasks found for %s task_id=%s",
                    plan.cleanup_source,
                    plan.task_id,
                )
            else:
                logger.info(
                    "[TaskCompletionHandler] Attempting immediate executor cleanup for %s task_id=%s executors=%s",
                    plan.cleanup_source,
                    plan.task_id,
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
                            plan.cleanup_source,
                            executor_namespace,
                            executor_name,
                            exc,
                        )

        if not successful_keys and not sandbox_deleted:
            logger.warning(
                "[TaskCompletionHandler] Immediate runtime cleanup finished without successful deletions for %s task_id=%s mode=%s",
                plan.cleanup_source,
                plan.task_id,
                cleanup_mode,
            )
            return

        outcome = _RuntimeCleanupOutcome(
            sandbox_deleted=sandbox_deleted,
            deleted_executors=frozenset(successful_keys),
        )
        await run_sync_in_executor(
            self._persist_runtime_cleanup_sync,
            plan,
            outcome,
        )
        logger.info(
            "[TaskCompletionHandler] Immediate executor cleanup succeeded for %s task_id=%s deleted_executors=%s sandbox_deleted=%s",
            plan.cleanup_source,
            plan.task_id,
            sorted(successful_keys),
            sandbox_deleted,
        )

    def _persist_runtime_cleanup_sync(
        self,
        plan: _RuntimeCleanupPlan,
        outcome: _RuntimeCleanupOutcome,
    ) -> None:
        """Persist successful runtime deletions in a worker-owned session."""
        with get_db_session() as db:
            for detached_subtask in plan.subtasks:
                executor_key = (
                    detached_subtask.executor_namespace,
                    detached_subtask.executor_name,
                )
                if not (
                    outcome.sandbox_deleted or executor_key in outcome.deleted_executors
                ):
                    continue
                subtask = subtask_store.get_basic_by_id(
                    db,
                    subtask_id=detached_subtask.subtask_id,
                )
                if not subtask:
                    logger.warning(
                        "[TaskCompletionHandler] Cannot mark deleted runtime: subtask_id=%s not found",
                        detached_subtask.subtask_id,
                    )
                    continue
                subtask_store.update_fields(
                    db,
                    subtask=subtask,
                    executor_deleted_at=True,
                )
            db.commit()

    async def _dispatch_notifications(
        self,
        intent: _NotificationIntent,
    ) -> None:
        """Load notification metadata in a worker, then send on this event loop."""
        try:
            context = await run_sync_in_executor(
                self._load_notification_context_sync,
                intent.subscription_id,
            )
            if context is None:
                return

            await subscription_notification_dispatcher.dispatch_execution_notifications_from_store(
                subscription_id=intent.subscription_id,
                execution_id=intent.execution_id,
                subscription_display_name=context.subscription_display_name,
                result_summary=intent.result_summary or "",
                status=intent.execution_status,
                detail_url=None,  # Could be added if needed
            )
            if context.webhooks:
                await subscription_notification_dispatcher.dispatch_webhook_notifications(
                    webhooks=list(context.webhooks),
                    subscription_display_name=context.subscription_display_name,
                    result_summary=intent.result_summary or "",
                    status=intent.execution_status,
                    execution_id=intent.execution_id,
                    detail_url=None,
                )

            logger.info(
                f"[TaskCompletionHandler] Notifications dispatched for "
                f"execution {intent.execution_id}"
            )
        except Exception as e:
            logger.error(
                f"[TaskCompletionHandler] Failed to dispatch notifications for "
                f"execution {intent.execution_id}: {e}",
                exc_info=True,
            )

    def _load_notification_context_sync(
        self,
        subscription_id: int,
    ) -> Optional[_NotificationContext]:
        """Load detached subscription notification metadata in a fresh session."""
        with get_db_session() as db:
            subscription = (
                db.query(Kind)
                .filter(
                    Kind.id == subscription_id,
                    Kind.kind == "Subscription",
                    Kind.is_active == True,
                )
                .first()
            )
            if not subscription:
                logger.warning(
                    "[TaskCompletionHandler] Subscription %s not found",
                    subscription_id,
                )
                return None

            subscription_crd = validate_subscription_for_read(subscription.json)
            display_name = subscription_crd.spec.displayName or subscription.name
            webhooks = tuple(
                webhook.model_copy(deep=True)
                for webhook in (subscription_crd.spec.notificationWebhooks or ())
            )
            return _NotificationContext(
                subscription_display_name=display_name,
                webhooks=webhooks,
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
