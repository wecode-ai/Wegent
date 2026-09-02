# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Inbox direct-agent handler: creates a Task and sends a chat message directly."""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.events import QueueMessageCreatedEvent, TaskCompletedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.user import User
from app.schemas.work_queue import AutoProcessConfig, TeamRef
from app.services.chat.storage.db import run_sync_in_executor
from app.services.readers import KindType, kindReader
from app.stores.tasks import task_store
from shared.models.db.enums import QueueMessageStatus
from shared.models.db.work_queue import QueueMessage

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _DirectAgentPlan:
    """Detached values required to create and dispatch one inbox task."""

    message_id: int
    user_id: int
    team_id: int
    message: str
    params: Any


class InboxDirectAgentHandler:
    """Handler that processes inbox messages by creating a Task directly via the
    chat interface, bypassing the Subscription/BackgroundExecution pipeline."""

    async def handle(
        self,
        event: QueueMessageCreatedEvent,
        auto_process: AutoProcessConfig,
    ) -> None:
        """Create a chat Task for the given inbox message.

        Steps:
        1. Resolve Team from teamRef.
        2. Determine workspace parameters from the team's most recent Task.
        3. Create a new chat Task via create_chat_task().
        4. Store the Task ID in QueueMessage.process_task_id.
        5. Update message status to PROCESSING.
        6. Register a one-shot listener on TaskCompletedEvent to flip the
           message to PROCESSED or FAILED when the Task finishes.
        """
        logger.info(
            f"[InboxDirectAgent] handle() called: "
            f"message_id={event.message_id}, queue_id={event.queue_id}, "
            f"auto_process.mode={auto_process.mode}, "
            f"auto_process.triggerMode={auto_process.triggerMode}, "
            f"auto_process.teamRef={auto_process.teamRef}"
        )

        try:
            plan = await run_sync_in_executor(
                self._prepare_direct_agent_sync,
                event,
                auto_process,
            )
        except Exception as exc:
            logger.error(
                "[InboxDirectAgent] Failed to prepare message %s: %s",
                event.message_id,
                exc,
                exc_info=True,
            )
            await run_sync_in_executor(
                self._mark_failed_by_id_sync,
                event.message_id,
                f"Task preparation failed: {exc}",
            )
            return
        if plan is None:
            return

        try:
            from app.services.chat.storage.task_manager import (
                create_chat_task_nonblocking,
            )

            result = await create_chat_task_nonblocking(
                user_id=plan.user_id,
                team_id=plan.team_id,
                message=plan.message,
                params=plan.params,
                should_trigger_ai=True,
            )
        except Exception as exc:
            logger.error(
                f"[InboxDirectAgent] Failed to create task for message "
                f"{plan.message_id}: {exc}",
                exc_info=True,
            )
            await run_sync_in_executor(
                self._mark_failed_by_id_sync,
                plan.message_id,
                f"Task creation failed: {exc}",
            )
            return

        task_id = result.task.id
        user_subtask_id = result.user_subtask.id if result.user_subtask else None
        assistant_subtask_id = (
            result.assistant_subtask.id if result.assistant_subtask else None
        )
        logger.info(
            f"[InboxDirectAgent] Created task {task_id} for message {plan.message_id}"
        )

        await run_sync_in_executor(
            self._persist_created_task_sync,
            plan.message_id,
            plan.user_id,
            task_id,
            user_subtask_id,
        )

        self._register_task_completion_listener(task_id, plan.message_id)

        if assistant_subtask_id is not None:
            try:
                await self._dispatch_ai_execution(
                    task_id=task_id,
                    assistant_subtask_id=assistant_subtask_id,
                    user_subtask_id=user_subtask_id,
                    team_id=plan.team_id,
                    user_id=plan.user_id,
                    message=plan.message,
                )
            except Exception as exc:
                await run_sync_in_executor(
                    self._mark_failed_by_id_sync,
                    plan.message_id,
                    f"AI dispatch failed: {exc}",
                )
        else:
            logger.warning(
                f"[InboxDirectAgent] No assistant subtask created for task {task_id}, "
                f"AI will not be triggered"
            )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _prepare_direct_agent_sync(
        self,
        event: QueueMessageCreatedEvent,
        auto_process: AutoProcessConfig,
    ) -> Optional[_DirectAgentPlan]:
        """Load and persist the direct-agent preparation in one worker session."""
        from app.services.chat.storage.task_manager import TaskCreationParams

        with get_db_session() as db:
            message = (
                db.query(QueueMessage)
                .filter(QueueMessage.id == event.message_id)
                .first()
            )
            work_queue = (
                db.query(Kind)
                .filter(
                    Kind.id == event.queue_id,
                    Kind.kind == "WorkQueue",
                    Kind.is_active == True,
                )
                .first()
            )
            if not message or not work_queue:
                logger.warning(
                    "[InboxDirectAgent] Missing message=%s or queue=%s",
                    event.message_id,
                    event.queue_id,
                )
                return None
            if message.status in (
                QueueMessageStatus.PROCESSING,
                QueueMessageStatus.PROCESSED,
            ):
                return None
            if not auto_process.teamRef:
                self._mark_failed(
                    db,
                    message,
                    "direct_agent mode requires teamRef configuration",
                )
                return None

            team = self._resolve_team(
                db,
                auto_process.teamRef,
                work_queue.user_id,
            )
            if not team:
                self._mark_failed(
                    db,
                    message,
                    f"Team '{auto_process.teamRef.namespace}/"
                    f"{auto_process.teamRef.name}' not found",
                )
                return None
            user = db.query(User).filter(User.id == work_queue.user_id).first()
            if not user:
                self._mark_failed(
                    db,
                    message,
                    f"User {work_queue.user_id} not found",
                )
                return None

            user_message = self._extract_user_message(message)
            if not user_message:
                self._mark_failed(
                    db,
                    message,
                    "No user message content found in snapshot",
                )
                return None
            workspace_params = self._find_latest_workspace_params(
                db,
                team,
                work_queue.user_id,
            )
            model_id, force_override, model_type = self._resolve_model_override(
                db=db,
                owner=user,
                auto_process=auto_process,
            )
            params = TaskCreationParams(
                message=user_message,
                model_id=model_id,
                force_override_bot_model=force_override,
                force_override_bot_model_type=model_type,
                task_type="chat" if not workspace_params else None,
                **workspace_params,
            )
            message.status = QueueMessageStatus.PROCESSING
            db.commit()
            return _DirectAgentPlan(
                message_id=message.id,
                user_id=user.id,
                team_id=team.id,
                message=user_message,
                params=params,
            )

    def _persist_created_task_sync(
        self,
        message_id: int,
        user_id: int,
        task_id: int,
        user_subtask_id: Optional[int],
    ) -> None:
        """Link attachments and persist the new task using a fresh session."""
        from app.services.inbox.attachments import link_inbox_attachments_to_subtask

        with get_db_session() as db:
            message = (
                db.query(QueueMessage).filter(QueueMessage.id == message_id).first()
            )
            if not message:
                raise ValueError(f"Inbox message {message_id} no longer exists")
            if user_subtask_id is not None:
                link_inbox_attachments_to_subtask(
                    db=db,
                    user_subtask_id=user_subtask_id,
                    user_id=user_id,
                    inbox_message_id=message_id,
                )
            message.process_task_id = task_id
            db.commit()

    def _mark_failed_by_id_sync(self, message_id: int, error: str) -> None:
        """Mark a message failed in a worker-owned session."""
        with get_db_session() as db:
            message = (
                db.query(QueueMessage).filter(QueueMessage.id == message_id).first()
            )
            if message:
                self._mark_failed(db, message, error)

    def _resolve_team(
        self,
        db: Session,
        ref: TeamRef,
        queue_owner_user_id: int,
    ) -> Optional[Kind]:
        """Resolve a Team Kind by reference, scoped to the queue owner."""
        from app.services.adapters.team_kinds import team_kinds_service

        return team_kinds_service.get_team_by_name_and_namespace(
            db=db,
            team_name=ref.name,
            team_namespace=ref.namespace,
            user_id=queue_owner_user_id,
        )

    def _extract_user_message(self, message: QueueMessage) -> str:
        """Extract and concatenate USER-role content from content_snapshot.

        When a USER message has no text content but has attachmentContextIds,
        it is treated as a valid message (attachments-only). A placeholder
        text is used so the downstream task creation does not fail.
        """
        snapshot = message.content_snapshot or []
        parts = []
        for snap in snapshot:
            if snap.get("role", "").upper() != "USER":
                continue
            text = snap.get("content", "").strip()
            if text:
                parts.append(text)
            elif snap.get("attachmentContextIds"):
                # Attachments-only message: use a placeholder so the task
                # creation pipeline receives a non-empty message string.
                parts.append("(See attached files)")
        return "\n\n".join(parts)

    def _find_latest_workspace_params(
        self,
        db: Session,
        team: Kind,
        user_id: int,
    ) -> dict:
        """Return workspace-related kwargs for TaskCreationParams from the team's
        most recent active Task. Returns an empty dict if no Task with a non-empty
        repository is found (resulting in a pure chat Task)."""
        latest_task = task_store.list_regular_active_tasks(
            db,
            user_id=user_id,
            order_by_id_desc=True,
            limit=50,
        )

        for task_resource in latest_task:
            spec = task_resource.json.get("spec", {})
            team_ref = spec.get("teamRef", {})
            # Match by team name + namespace
            if (
                team_ref.get("name") == team.name
                and team_ref.get("namespace") == team.namespace
            ):
                workspace_ref = spec.get("workspaceRef")
                if workspace_ref:
                    # Find the matching Workspace TaskResource
                    workspace = task_store.get_workspace_by_ref(
                        db,
                        user_id=user_id,
                        name=workspace_ref.get("name"),
                        namespace=workspace_ref.get("namespace", "default"),
                    )
                    if workspace:
                        repo = workspace.json.get("spec", {}).get("repository", {})
                        if repo.get("gitUrl") or repo.get("gitRepoId"):
                            return {
                                "git_url": repo.get("gitUrl") or None,
                                "git_repo": repo.get("gitRepo") or None,
                                "git_repo_id": repo.get("gitRepoId") or None,
                                "git_domain": repo.get("gitDomain") or None,
                                "branch_name": repo.get("branchName") or None,
                            }
        return {}

    def _resolve_model_override(
        self,
        db: Session,
        owner: User,
        auto_process: AutoProcessConfig,
    ) -> tuple[Optional[str], bool, Optional[str]]:
        """Resolve queue-configured model override for direct agent execution."""
        if not auto_process.modelRef:
            return None, False, None

        model_kind = kindReader.get_by_name_and_namespace(
            db,
            owner.id,
            KindType.MODEL,
            auto_process.modelRef.namespace,
            auto_process.modelRef.name,
        )

        model_type = None
        if model_kind:
            if model_kind.user_id == 0:
                model_type = "public"
            elif model_kind.namespace == "default":
                model_type = "user"
            else:
                model_type = "group"

        return (
            auto_process.modelRef.name,
            auto_process.forceOverrideBotModel,
            model_type,
        )

    async def _dispatch_ai_execution(
        self,
        task_id: int,
        assistant_subtask_id: int,
        team_id: int,
        user_id: int,
        message: str,
        user_subtask_id: Optional[int],
    ) -> None:
        """Dispatch AI execution using the unified execution pipeline.

        Runs entirely on the EventBus-owned event loop.
        """
        from app.services.execution import execution_dispatcher
        from app.services.execution.emitters import SSEResultEmitter

        logger.info(
            f"[InboxDirectAgent] Dispatching AI execution: "
            f"task_id={task_id}, subtask_id={assistant_subtask_id}"
        )

        try:
            request = await self._build_ai_execution_request(
                task_id=task_id,
                assistant_subtask_id=assistant_subtask_id,
                team_id=team_id,
                user_id=user_id,
                message=message,
                user_subtask_id=user_subtask_id,
            )
            if not request:
                return

            emitter = SSEResultEmitter(
                task_id=task_id,
                subtask_id=assistant_subtask_id,
            )

            dispatch_task = asyncio.create_task(
                execution_dispatcher.dispatch(request, emitter=emitter)
            )

            # Collect response (waits for completion)
            accumulated_content, _ = await emitter.collect()

            try:
                await dispatch_task
            except Exception:
                pass  # Error already handled via emitter

            logger.info(
                f"[InboxDirectAgent] AI execution completed: "
                f"task_id={task_id}, content_length={len(accumulated_content)}"
            )

        except Exception as exc:
            logger.error(
                f"[InboxDirectAgent] AI dispatch failed for task {task_id}: {exc}",
                exc_info=True,
            )
            raise

    async def _build_ai_execution_request(
        self,
        task_id: int,
        assistant_subtask_id: int,
        team_id: int,
        user_id: int,
        message: str,
        user_subtask_id: Optional[int],
    ):
        """Build an execution request from scalar database identities."""
        from app.services.chat.trigger.unified import build_execution_request

        return await build_execution_request(
            task=task_id,
            assistant_subtask=assistant_subtask_id,
            team=team_id,
            user=user_id,
            message=message,
            payload=None,
            user_subtask_id=user_subtask_id,
            is_subscription=False,
            enable_tools=True,
            enable_deep_thinking=True,
        )

    def _mark_failed(self, db: Session, message: QueueMessage, error: str) -> None:
        """Mark the message as failed with the given error."""
        message.status = QueueMessageStatus.FAILED
        message.process_result = {"error": error}
        db.commit()
        logger.warning(f"[InboxDirectAgent] Message {message.id} failed: {error}")

    def _update_message_from_task_completion_sync(
        self,
        message_id: int,
        task_id: int,
        event: TaskCompletedEvent,
    ) -> None:
        """Update one inbox message inside a database worker thread."""
        is_failure = event.status in ("FAILED", "CANCELLED") or bool(event.error)
        with get_db_session() as db:
            message = (
                db.query(QueueMessage).filter(QueueMessage.id == message_id).first()
            )
            if not message:
                return
            if is_failure:
                message.status = QueueMessageStatus.FAILED
                message.process_result = {
                    "error": event.error or "Task ended with failure status",
                    "taskId": task_id,
                }
            else:
                message.status = QueueMessageStatus.PROCESSED
                message.process_result = {"taskId": task_id}
            db.commit()
            logger.info(
                "[InboxDirectAgent] Message %s updated to %s after task %s completion",
                message_id,
                message.status,
                task_id,
            )

    def _register_task_completion_listener(self, task_id: int, message_id: int) -> None:
        """Register a one-shot TaskCompletedEvent listener that updates the
        QueueMessage status when the given Task reaches a terminal state."""
        from app.core.events import get_event_bus

        event_bus = get_event_bus()
        # unsubscribe_fn is set after subscribe() returns so the closure can call it
        unsubscribe_fn: list = []  # mutable container for the unsubscribe callable

        async def _on_task_completed(event: TaskCompletedEvent) -> None:
            if event.task_id != task_id:
                return

            # Unsubscribe immediately (one-shot) using the stored callable
            if unsubscribe_fn:
                unsubscribe_fn[0]()

            try:
                await run_sync_in_executor(
                    self._update_message_from_task_completion_sync,
                    message_id,
                    task_id,
                    event,
                )
            except Exception as exc:
                logger.error(
                    f"[InboxDirectAgent] Failed to update message {message_id} "
                    f"status after task {task_id}: {exc}",
                    exc_info=True,
                )

        # subscribe() returns an unsubscribe callable; store it so the async
        # handler can call it on first invocation (one-shot pattern).
        unsubscribe = event_bus.subscribe(TaskCompletedEvent, _on_task_completed)
        unsubscribe_fn.append(unsubscribe)


# Singleton instance
inbox_direct_agent_handler = InboxDirectAgentHandler()
