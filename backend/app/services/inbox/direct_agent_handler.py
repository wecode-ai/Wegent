# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Inbox direct-agent handler: creates a Task and sends a chat message directly."""

import asyncio
import logging
import threading
from typing import Optional

from sqlalchemy.orm import Session

from app.core.events import QueueMessageCreatedEvent, TaskCompletedEvent
from app.db.session import get_db_session
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.work_queue import AutoProcessConfig, TeamRef
from shared.models.db.enums import QueueMessageStatus
from shared.models.db.work_queue import QueueMessage

logger = logging.getLogger(__name__)


class InboxDirectAgentHandler:
    """Handler that processes inbox messages by creating a Task directly via the
    chat interface, bypassing the Subscription/BackgroundExecution pipeline."""

    async def handle(
        self,
        event: QueueMessageCreatedEvent,
        auto_process: AutoProcessConfig,
        message: QueueMessage,
        work_queue: Kind,
        db: Session,
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
            f"message_id={message.id}, queue_id={work_queue.id}, "
            f"work_queue_user_id={work_queue.user_id}, "
            f"auto_process.mode={auto_process.mode}, "
            f"auto_process.triggerMode={auto_process.triggerMode}, "
            f"auto_process.teamRef={auto_process.teamRef}"
        )

        if not auto_process.teamRef:
            self._mark_failed(
                db, message, "direct_agent mode requires teamRef configuration"
            )
            return

        # Resolve Team
        logger.info(
            f"[InboxDirectAgent] Resolving team: "
            f"namespace={auto_process.teamRef.namespace}, "
            f"name={auto_process.teamRef.name}, "
            f"user_id={work_queue.user_id}"
        )
        team = self._resolve_team(db, auto_process.teamRef, work_queue.user_id)
        if not team:
            self._mark_failed(
                db,
                message,
                f"Team '{auto_process.teamRef.namespace}/{auto_process.teamRef.name}' "
                "not found",
            )
            return

        logger.info(
            f"[InboxDirectAgent] Resolved team: id={team.id}, name={team.name}, "
            f"namespace={team.namespace}, user_id={team.user_id}"
        )

        # Resolve the owner User object required by create_chat_task()
        user = db.query(User).filter(User.id == work_queue.user_id).first()
        if not user:
            self._mark_failed(db, message, f"User {work_queue.user_id} not found")
            return

        logger.info(
            f"[InboxDirectAgent] Resolved user: id={user.id}, "
            f"user_name={user.user_name}"
        )

        # Build user message text from content_snapshot
        logger.info(
            f"[InboxDirectAgent] Extracting user message from content_snapshot: "
            f"snapshot={message.content_snapshot}"
        )
        user_message = self._extract_user_message(message)
        logger.info(
            f"[InboxDirectAgent] Extracted user_message: "
            f"len={len(user_message) if user_message else 0}, "
            f"preview={repr(user_message[:100]) if user_message else None}"
        )
        if not user_message:
            self._mark_failed(db, message, "No user message content found in snapshot")
            return

        # Look up workspace params from the team's most recent active Task
        workspace_params = self._find_latest_workspace_params(
            db, team, work_queue.user_id
        )

        # Build TaskCreationParams
        from app.services.chat.storage.task_manager import TaskCreationParams

        params = TaskCreationParams(
            message=user_message,
            task_type="chat" if not workspace_params else None,
            **workspace_params,
        )

        # Mark PROCESSING before async dispatch
        message.status = QueueMessageStatus.PROCESSING
        db.commit()

        # Create the Task
        try:
            from app.services.chat.storage.task_manager import create_chat_task

            result = await create_chat_task(
                db=db,
                user=user,
                team=team,
                message=user_message,
                params=params,
                should_trigger_ai=True,
                source="inbox",
            )
        except Exception as exc:
            logger.error(
                f"[InboxDirectAgent] Failed to create task for message "
                f"{message.id}: {exc}",
                exc_info=True,
            )
            self._mark_failed(db, message, f"Task creation failed: {exc}")
            return

        task_id = result.task.id
        logger.info(
            f"[InboxDirectAgent] Created task {task_id} for message {message.id}"
        )

        # Link inbox message attachments to user_subtask so the LLM can access them.
        # Uses the shared utility also used by subscription mode.
        if result.user_subtask:
            from app.services.inbox.attachments import link_inbox_attachments_to_subtask

            link_inbox_attachments_to_subtask(
                db=db,
                user_subtask_id=result.user_subtask.id,
                user_id=user.id,
                inbox_message_id=message.id,
            )

        # Persist task ID and remain in PROCESSING state
        message.process_task_id = task_id
        db.commit()

        # Register a one-shot listener so we can update message status when done
        self._register_task_completion_listener(task_id, message.id)

        # Trigger AI execution in a background thread to avoid blocking the event handler
        if result.assistant_subtask:
            self._trigger_ai_in_background(
                task_id=task_id,
                assistant_subtask_id=result.assistant_subtask.id,
                user_subtask_id=result.user_subtask.id if result.user_subtask else None,
                team_id=team.id,
                user_id=user.id,
                message=user_message,
            )
        else:
            logger.warning(
                f"[InboxDirectAgent] No assistant subtask created for task {task_id}, "
                f"AI will not be triggered"
            )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

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
        latest_task = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
            )
            .order_by(TaskResource.id.desc())
            .limit(50)
            .all()
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
                    workspace = (
                        db.query(TaskResource)
                        .filter(
                            TaskResource.user_id == user_id,
                            TaskResource.kind == "Workspace",
                            TaskResource.name == workspace_ref.get("name"),
                            TaskResource.namespace
                            == workspace_ref.get("namespace", "default"),
                        )
                        .first()
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

    def _trigger_ai_in_background(
        self,
        task_id: int,
        assistant_subtask_id: int,
        user_subtask_id: Optional[int],
        team_id: int,
        user_id: int,
        message: str,
    ) -> None:
        """Trigger AI execution in a background thread.

        Runs the AI dispatch in a separate thread with its own event loop to avoid
        blocking the event handler and to prevent event loop conflicts.
        """

        def _run_in_thread() -> None:
            thread_loop = asyncio.new_event_loop()
            asyncio.set_event_loop(thread_loop)
            try:
                with get_db_session() as thread_db:
                    # Reload ORM objects in this thread's session
                    thread_task = (
                        thread_db.query(TaskResource)
                        .filter(
                            TaskResource.id == task_id,
                            TaskResource.kind == "Task",
                        )
                        .first()
                    )
                    if not thread_task:
                        logger.error(
                            f"[InboxDirectAgent] Task {task_id} not found in AI trigger thread"
                        )
                        return

                    thread_assistant_subtask = (
                        thread_db.query(Subtask)
                        .filter(Subtask.id == assistant_subtask_id)
                        .first()
                    )
                    if not thread_assistant_subtask:
                        logger.error(
                            f"[InboxDirectAgent] Assistant subtask {assistant_subtask_id} "
                            f"not found in AI trigger thread"
                        )
                        return

                    thread_team = (
                        thread_db.query(Kind)
                        .filter(Kind.id == team_id, Kind.kind == "Team")
                        .first()
                    )
                    if not thread_team:
                        logger.error(
                            f"[InboxDirectAgent] Team {team_id} not found in AI trigger thread"
                        )
                        return

                    thread_user = (
                        thread_db.query(User).filter(User.id == user_id).first()
                    )
                    if not thread_user:
                        logger.error(
                            f"[InboxDirectAgent] User {user_id} not found in AI trigger thread"
                        )
                        return

                    thread_loop.run_until_complete(
                        self._dispatch_ai_execution(
                            task=thread_task,
                            assistant_subtask=thread_assistant_subtask,
                            team=thread_team,
                            user=thread_user,
                            message=message,
                            user_subtask_id=user_subtask_id,
                        )
                    )
            except Exception as exc:
                logger.error(
                    f"[InboxDirectAgent] AI trigger thread failed for task {task_id}: {exc}",
                    exc_info=True,
                )
            finally:
                thread_loop.close()

        thread = threading.Thread(target=_run_in_thread, daemon=True)
        thread.start()
        logger.info(f"[InboxDirectAgent] Started AI trigger thread for task {task_id}")

    async def _dispatch_ai_execution(
        self,
        task: TaskResource,
        assistant_subtask: Subtask,
        team: Kind,
        user: User,
        message: str,
        user_subtask_id: Optional[int],
    ) -> None:
        """Dispatch AI execution using the unified execution pipeline.

        Uses SSEResultEmitter (thread-safe) to avoid WebSocket/Socket.IO
        cross-thread issues.
        """
        from app.services.chat.trigger.unified import build_execution_request
        from app.services.execution import execution_dispatcher
        from app.services.execution.emitters import SSEResultEmitter

        logger.info(
            f"[InboxDirectAgent] Dispatching AI execution: "
            f"task_id={task.id}, subtask_id={assistant_subtask.id}"
        )

        try:
            request = await build_execution_request(
                task=task,
                assistant_subtask=assistant_subtask,
                team=team,
                user=user,
                message=message,
                payload=None,
                user_subtask_id=user_subtask_id,
                is_subscription=False,
                enable_tools=True,
                enable_deep_thinking=True,
            )

            # Use SSEResultEmitter to avoid WebSocket/Socket.IO cross-thread issues
            emitter = SSEResultEmitter(
                task_id=task.id,
                subtask_id=assistant_subtask.id,
            )

            dispatch_task = asyncio.create_task(
                execution_dispatcher.dispatch(request, emitter=emitter)
            )

            # Collect response (waits for completion)
            accumulated_content, final_event = await emitter.collect()

            try:
                await dispatch_task
            except Exception:
                pass  # Error already handled via emitter

            logger.info(
                f"[InboxDirectAgent] AI execution completed: "
                f"task_id={task.id}, content_length={len(accumulated_content)}"
            )

        except Exception as exc:
            logger.error(
                f"[InboxDirectAgent] AI dispatch failed for task {task.id}: {exc}",
                exc_info=True,
            )

    def _mark_failed(self, db: Session, message: QueueMessage, error: str) -> None:
        """Mark the message as failed with the given error."""
        message.status = QueueMessageStatus.FAILED
        message.process_result = {"error": error}
        db.commit()
        logger.warning(f"[InboxDirectAgent] Message {message.id} failed: {error}")

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

            # TaskCompletedEvent.status is a plain string: COMPLETED / FAILED / CANCELLED
            is_failure = event.status in ("FAILED", "CANCELLED") or bool(event.error)

            try:
                with get_db_session() as db:
                    msg = (
                        db.query(QueueMessage)
                        .filter(QueueMessage.id == message_id)
                        .first()
                    )
                    if not msg:
                        return
                    if is_failure:
                        msg.status = QueueMessageStatus.FAILED
                        msg.process_result = {
                            "error": event.error or "Task ended with failure status",
                            "taskId": task_id,
                        }
                    else:
                        msg.status = QueueMessageStatus.PROCESSED
                        msg.process_result = {"taskId": task_id}
                    db.commit()
                    logger.info(
                        f"[InboxDirectAgent] Message {message_id} updated to "
                        f"{msg.status} after task {task_id} completion"
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
