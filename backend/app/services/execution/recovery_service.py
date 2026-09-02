# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Executor recovery service for Pod recreation after deletion.

When a user sends a message to a task whose executor has been deleted
(executor_deleted_at=True), this service:
1. Recreates the Pod with skip_git_clone=true (to avoid git clone conflict)
2. Restores workspace files from archive (if available)
3. Returns new executor info to caller
4. Caller should update current subtask with new executor info

If archive is not available or expired, the Pod is created normally
with git clone enabled.
"""

import logging
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.payload_codec import run_payload_codec
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.services.task_status import extract_task_error, mark_task_failed
from app.services.workspace_archive import archive_service
from app.stores.tasks import subtask_store, task_store
from shared.models import ExecutionRequest
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ExecutorRecoveryContext:
    """Detached database state required by executor recovery."""

    task_id: int
    subtask_id: int
    task_json: Dict[str, Any]
    previous_executor_name: Optional[str]
    previous_executor_namespace: Optional[str]
    executor_deleted_at: bool
    archive_available: bool
    archive_reason: Optional[str]
    prior_claude_session_evidence: bool
    subtask_error: Optional[str]
    task_error: Optional[str]


@dataclass(frozen=True)
class ExecutorRecoveryOutcome:
    """Result of detached executor recovery."""

    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None
    error_message: Optional[str] = None

    @property
    def recovered(self) -> bool:
        return bool(self.executor_name and self.executor_namespace)


class ExecutorRecoveryService:
    """Service for recovering executor Pods after deletion.

    This service is called by ExecutionDispatcher when it detects that
    a subtask's executor has been deleted (executor_deleted_at=True).

    Recovery flow:
    1. Check if archive exists and is valid (not expired)
    2. Create Pod with skip_git_clone=true if archive exists
    3. Restore workspace from archive
    4. Return new executor info to caller
    5. Caller updates current subtask with new executor info

    If archive is not available:
    1. Create Pod normally (with git clone)
    2. Return new executor info to caller
    3. Caller updates current subtask with new executor info
    """

    def _resolve_executor_namespace(
        self,
        sandbox: object,
        previous_namespace: Optional[str],
    ) -> str:
        namespace = getattr(sandbox, "executor_namespace", None)
        if isinstance(namespace, str) and namespace.strip():
            return namespace.strip()

        metadata = getattr(sandbox, "metadata", None)
        if isinstance(metadata, dict):
            metadata_namespace = metadata.get("executor_namespace")
            if isinstance(metadata_namespace, str) and metadata_namespace.strip():
                return metadata_namespace.strip()

        if isinstance(previous_namespace, str) and previous_namespace.strip():
            return previous_namespace.strip()

        return "default"

    def _persist_recovery_failure(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        error_message: str,
    ) -> None:
        """Persist executor prepare failures for later inspection and UI display."""
        subtask.error_message = error_message
        subtask.status = SubtaskStatus.FAILED
        subtask.progress = 100
        mark_task_failed(task, error_message)
        db.add(subtask)
        db.add(task)
        db.commit()

    @staticmethod
    def _requires_claude_session(request: ExecutionRequest) -> bool:
        if request.new_session:
            return False
        bots = request.bot if isinstance(request.bot, list) else [request.bot]
        return any(
            isinstance(bot, dict) and bot.get("shell_type") == "ClaudeCode"
            for bot in bots
        )

    @staticmethod
    def _has_inherited_claude_session(request: ExecutionRequest) -> bool:
        bots = request.bot if isinstance(request.bot, list) else [request.bot]
        bot_ids = {
            str(bot["id"])
            for bot in bots
            if isinstance(bot, dict) and bot.get("id") is not None
        }
        for session in request.inherited_sessions:
            if not isinstance(session, dict):
                continue
            if session.get("agent") not in {"ClaudeCode", "Claude Code"}:
                continue
            session_id = session.get("sessionId") or session.get("session_id")
            if not ExecutorRecoveryService._is_safe_session_identifier(session_id):
                continue
            session_bot_id: Any = session.get("botId", session.get("bot_id"))
            if bot_ids and session_bot_id is not None:
                if str(session_bot_id) not in bot_ids:
                    continue
            return True
        return False

    @staticmethod
    def _is_safe_session_identifier(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        value = value.strip()
        return bool(value) and all(
            character.isascii() and (character.isalnum() or character in {"-", "_"})
            for character in value
        )

    def _has_prior_claude_session_evidence(
        self,
        db: Session,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> bool:
        """Return True when the task provably had a Claude session before.

        Legacy tasks completed before session persistence shipped have neither
        an archive session marker nor a persisted executor session. Those tasks
        must be allowed to continue with a fresh session; the guard only
        rejects recovery when a session existed and could not be restored.
        """
        task_json = getattr(task, "json", None)
        if not isinstance(task_json, dict):
            task_json = {}
        status = task_json.get("status")
        if not isinstance(status, dict):
            status = {}
        archive = status.get("archive") if isinstance(status, dict) else {}
        if isinstance(archive, dict) and archive.get("sessionFileIncluded"):
            return True

        assistant_subtasks = subtask_store.list_assistant_by_task(
            db,
            task_id=task.id,
            owner_user_id=request.user_id,
        )
        for assistant_subtask in assistant_subtasks:
            result = getattr(assistant_subtask, "result", None)
            if isinstance(result, dict) and result.get("executor_session"):
                return True
        return False

    @trace_async("execution.cleanup_prepared_executor", "execution.recovery")
    async def _delete_prepared_executor(self, *, task_id: int) -> None:
        """Best-effort cleanup of a freshly prepared executor after failure."""
        from app.services.execution import get_executor_runtime_client

        try:
            deleted, error = await get_executor_runtime_client().delete_sandbox(
                str(task_id)
            )
            if not deleted:
                logger.warning(
                    f"[RecoveryService] Failed to delete recovered executor "
                    f"for task {task_id}: {error}"
                )
        except Exception as exc:
            logger.warning(
                f"[RecoveryService] Error deleting recovered executor "
                f"for task {task_id}: {exc}"
            )

    def build_detached_context(
        self,
        db: Session,
        *,
        subtask: Subtask,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> ExecutorRecoveryContext:
        """Copy recovery inputs while the caller's database session is active."""
        archive_available, _, archive_reason = archive_service.check_archive_available(
            task
        )
        prior_session_evidence = False
        if archive_available and self._requires_claude_session(request):
            prior_session_evidence = self._has_prior_claude_session_evidence(
                db,
                task,
                request,
            )
        subtask_error = getattr(subtask, "error_message", None)
        return ExecutorRecoveryContext(
            task_id=task.id,
            subtask_id=subtask.id,
            task_json=deepcopy(task.json),
            previous_executor_name=subtask.executor_name,
            previous_executor_namespace=subtask.executor_namespace,
            executor_deleted_at=bool(subtask.executor_deleted_at),
            archive_available=archive_available,
            archive_reason=archive_reason,
            prior_claude_session_evidence=prior_session_evidence,
            subtask_error=(
                subtask_error
                if isinstance(subtask_error, str) and subtask_error.strip()
                else None
            ),
            task_error=extract_task_error(task),
        )

    async def recover_from_store(
        self,
        *,
        task_id: int,
        subtask_id: int,
        request: ExecutionRequest,
    ) -> ExecutorRecoveryOutcome:
        """Recover and persist executor state without a caller-owned session."""
        from app.services.chat.storage.db import run_sync_in_executor

        context = await run_sync_in_executor(
            self._load_detached_context_sync,
            task_id,
            subtask_id,
            request,
        )
        outcome = await self.recover_detached(context=context, request=request)
        if outcome.recovered:
            await run_sync_in_executor(
                self._persist_recovered_executor_sync,
                subtask_id,
                outcome.executor_name,
                outcome.executor_namespace,
            )
        return outcome

    def _load_detached_context_sync(
        self,
        task_id: int,
        subtask_id: int,
        request: ExecutionRequest,
    ) -> ExecutorRecoveryContext:
        """Load recovery inputs inside a worker-owned session."""
        from app.db.session import get_db_session

        with get_db_session() as db:
            task = task_store.get_by_id(db, task_id=task_id)
            subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
            if not task or not subtask:
                raise ValueError(
                    f"Recovery state missing for task={task_id} subtask={subtask_id}"
                )
            return self.build_detached_context(
                db,
                subtask=subtask,
                task=task,
                request=request,
            )

    def _persist_recovered_executor_sync(
        self,
        subtask_id: int,
        executor_name: Optional[str],
        executor_namespace: Optional[str],
    ) -> None:
        """Persist a successful recovery in a fresh worker session."""
        from app.db.session import get_db_session

        if not executor_name or not executor_namespace:
            raise ValueError("Recovered executor identity is incomplete")
        with get_db_session() as db:
            subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
            if not subtask:
                raise ValueError(f"Subtask {subtask_id} no longer exists")
            subtask_store.update_fields(
                db,
                subtask=subtask,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
                executor_deleted_at=False,
            )
            db.commit()

    async def recover_detached(
        self,
        *,
        context: ExecutorRecoveryContext,
        request: ExecutionRequest,
    ) -> ExecutorRecoveryOutcome:
        """Recover from detached state without retaining a database session."""
        logger.info(
            "[RecoveryService] Starting detached recovery for task %s, subtask %s",
            context.task_id,
            context.subtask_id,
        )
        if context.archive_reason == "expired":
            raise RuntimeError(
                f"Workspace archive for task {context.task_id} has expired (>30 days). "
                "This task can no longer be resumed. Please create a new task to continue."
            )
        if context.archive_available:
            return await self._recover_detached_with_archive(context, request)
        return await self._recover_detached_without_archive(context, request)

    async def _recover_detached_with_archive(
        self,
        context: ExecutorRecoveryContext,
        request: ExecutionRequest,
    ) -> ExecutorRecoveryOutcome:
        """Recover and restore an archived workspace from detached state."""
        prepared_executor_pending_cleanup = False
        try:
            request.skip_git_clone = True
            request.executor_name = None
            request.executor_namespace = None
            executor, error = await self._prepare_executor(request, True)
            if error or not executor:
                if error:
                    await self._persist_detached_failure(context, error)
                return ExecutorRecoveryOutcome(error_message=error)

            executor_name = executor.container_name
            executor_namespace = self._resolve_executor_namespace(
                executor,
                context.previous_executor_namespace,
            )
            prepared_executor_pending_cleanup = True
            task_json = await run_payload_codec(
                deepcopy,
                context.task_json,
                payload_hint=context.task_json,
                force_offload=True,
            )
            restore_result = await archive_service.restore_workspace_snapshot(
                task_id=context.task_id,
                task_json=task_json,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )
            session_available = bool(restore_result) and bool(
                restore_result.get("session_restored", False)
                or self._has_inherited_claude_session(request)
            )
            if self._requires_claude_session(request) and not session_available:
                if context.prior_claude_session_evidence:
                    error = (
                        f"Claude session context for task {context.task_id} was not "
                        "restored. Refusing to send the continuation to a new session."
                    )
                    await self._persist_detached_failure(context, error)
                    raise RuntimeError(error)
                logger.warning(
                    "[RecoveryService] No prior Claude session evidence for task %s; "
                    "continuing recovery with a new session",
                    context.task_id,
                )
            if not restore_result:
                logger.warning(
                    "[RecoveryService] Failed to restore workspace for task %s, "
                    "continuing with empty workspace",
                    context.task_id,
                )

            request.executor_name = executor_name
            request.executor_namespace = executor_namespace
            return ExecutorRecoveryOutcome(
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )
        except RuntimeError:
            if prepared_executor_pending_cleanup:
                await self._delete_prepared_executor(task_id=context.task_id)
            raise
        except Exception as exc:
            if prepared_executor_pending_cleanup:
                await self._delete_prepared_executor(task_id=context.task_id)
            logger.error(
                "[RecoveryService] Error recovering detached archive for task %s: %s",
                context.task_id,
                exc,
                exc_info=True,
            )
            return ExecutorRecoveryOutcome(error_message=str(exc))

    async def _recover_detached_without_archive(
        self,
        context: ExecutorRecoveryContext,
        request: ExecutionRequest,
    ) -> ExecutorRecoveryOutcome:
        """Recover a detached task with a normal workspace clone."""
        try:
            request.skip_git_clone = False
            request.executor_name = None
            request.executor_namespace = None
            executor, error = await self._prepare_executor(request, False)
            if error or not executor:
                if error:
                    await self._persist_detached_failure(context, error)
                return ExecutorRecoveryOutcome(error_message=error)

            executor_name = executor.container_name
            executor_namespace = self._resolve_executor_namespace(
                executor,
                context.previous_executor_namespace,
            )
            request.executor_name = executor_name
            request.executor_namespace = executor_namespace
            return ExecutorRecoveryOutcome(
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )
        except Exception as exc:
            logger.error(
                "[RecoveryService] Error recovering detached task %s: %s",
                context.task_id,
                exc,
                exc_info=True,
            )
            return ExecutorRecoveryOutcome(error_message=str(exc))

    async def _persist_detached_failure(
        self,
        context: ExecutorRecoveryContext,
        error_message: str,
    ) -> None:
        """Persist recovery failure in a fresh worker-owned session."""
        from app.services.chat.storage.db import run_sync_in_executor

        await run_sync_in_executor(
            self._persist_detached_failure_sync,
            context.task_id,
            context.subtask_id,
            error_message,
        )

    def _persist_detached_failure_sync(
        self,
        task_id: int,
        subtask_id: int,
        error_message: str,
    ) -> None:
        from app.db.session import get_db_session

        with get_db_session() as db:
            subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
            task = task_store.get_by_id(db, task_id=task_id)
            if not subtask or not task:
                logger.error(
                    "[RecoveryService] Cannot persist recovery failure: task=%s subtask=%s",
                    task_id,
                    subtask_id,
                )
                return
            self._persist_recovery_failure(db, subtask, task, error_message)

    async def recover(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> Optional[Dict[str, str]]:
        """Recover executor Pod for a task.

        Args:
            db: Database session
            subtask: Subtask with executor_deleted_at=True (used for workspace restore)
            task: Parent task
            request: Execution request carrying the normal executor config

        Returns:
            Dict with executor_name and executor_namespace if successful,
            None otherwise. Caller should use this info to update current subtask.
        """
        task_id = task.id
        logger.info(
            f"[RecoveryService] Starting recovery for task {task_id}, "
            f"subtask {subtask.id}"
        )

        try:
            # Check if archive is available
            archive_available, storage_key, reason = (
                archive_service.check_archive_available(task)
            )

            # Archive exists but expired - reject task execution
            if reason == "expired":
                logger.warning(
                    f"[RecoveryService] Archive expired for task {task_id}, "
                    "rejecting task execution"
                )
                raise RuntimeError(
                    f"Workspace archive for task {task_id} has expired (>30 days). "
                    "This task can no longer be resumed. "
                    "Please create a new task to continue."
                )

            if archive_available:
                logger.info(
                    f"[RecoveryService] Archive found for task {task_id}, "
                    f"will restore from archive"
                )
                result = await self._recover_with_archive(
                    db=db,
                    subtask=subtask,
                    task=task,
                    request=request,
                )
                if result:
                    return {
                        "executor_name": request.executor_name,
                        "executor_namespace": request.executor_namespace,
                    }
                return None
            else:
                logger.info(
                    f"[RecoveryService] No archive for task {task_id}, "
                    "will create Pod with git clone"
                )
                result = await self._recover_without_archive(
                    db=db,
                    subtask=subtask,
                    task=task,
                    request=request,
                )
                if result:
                    return {
                        "executor_name": request.executor_name,
                        "executor_namespace": request.executor_namespace,
                    }
                return None

        except RuntimeError:
            raise
        except Exception as e:
            logger.error(
                f"[RecoveryService] Error recovering task {task_id}: {e}",
                exc_info=True,
            )
            return None

    async def _recover_with_archive(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> bool:
        """Recover Pod using workspace archive.

        1. Create Pod with skip_git_clone=true
        2. Restore workspace from archive
        3. Reset executor_deleted_at=False

        Args:
            db: Database session
            subtask: Subtask
            task: Task
            request: Execution request carrying the normal executor config

        Returns:
            True if successful, False otherwise
        """
        task_id = task.id

        prepared_executor_pending_cleanup = False
        try:
            request.skip_git_clone = True
            request.executor_name = None
            request.executor_namespace = None

            executor, error = await self._prepare_executor(request, True)

            if error or not executor:
                logger.error(
                    f"[RecoveryService] Failed to prepare executor for task {task_id}: {error}"
                )
                if error:
                    self._persist_recovery_failure(db, subtask, task, error)
                return False

            executor_name = executor.container_name
            executor_namespace = self._resolve_executor_namespace(
                sandbox=executor,
                previous_namespace=subtask.executor_namespace,
            )
            prepared_executor_pending_cleanup = True

            # Restore workspace from archive
            raw_task_json = getattr(task, "json", {}) or {}
            task_json = await run_payload_codec(
                deepcopy,
                raw_task_json,
                payload_hint=raw_task_json,
                force_offload=True,
            )
            restore_result = await archive_service.restore_workspace_snapshot(
                task_id=task.id,
                task_json=task_json,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )

            session_available = bool(restore_result) and bool(
                restore_result.get("session_restored", False)
                or self._has_inherited_claude_session(request)
            )
            if self._requires_claude_session(request) and not session_available:
                if not self._has_prior_claude_session_evidence(db, task, request):
                    # Legacy tasks predate session persistence: no archive marker
                    # and no persisted executor session can exist. Continuing with
                    # a new session preserves the pre-guard behavior for them.
                    logger.warning(
                        f"[RecoveryService] No prior Claude session evidence for "
                        f"task {task_id}; continuing recovery with a new session"
                    )
                else:
                    error = (
                        f"Claude session context for task {task_id} was not restored. "
                        "Refusing to send the continuation to a new session."
                    )
                    logger.error(f"[RecoveryService] {error}")
                    self._persist_recovery_failure(db, subtask, task, error)
                    raise RuntimeError(error)

            if not restore_result:
                logger.warning(
                    f"[RecoveryService] Failed to restore workspace for task {task_id}, "
                    "continuing with empty workspace"
                )

            # Set executor info in request for caller to use
            # Note: We do NOT update the subtask here - caller should update
            # the current subtask with this info to preserve history
            request.executor_name = executor_name
            request.executor_namespace = executor_namespace

            logger.info(
                f"[RecoveryService] Successfully recovered task {task_id} with archive, "
                f"executor={executor_namespace}/{executor_name}"
            )

            return True

        except RuntimeError:
            if prepared_executor_pending_cleanup:
                await self._delete_prepared_executor(task_id=task_id)
            raise
        except Exception as e:
            if prepared_executor_pending_cleanup:
                await self._delete_prepared_executor(task_id=task_id)
            logger.error(
                f"[RecoveryService] Error recovering with archive for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def _recover_without_archive(
        self,
        db: Session,
        subtask: Subtask,
        task: TaskResource,
        request: ExecutionRequest,
    ) -> bool:
        """Recover Pod with normal git clone (no archive).

        1. Create Pod normally (git clone will happen)
        2. Reset executor_deleted_at=False

        Args:
            db: Database session
            subtask: Subtask
            task: Task
            request: Execution request carrying the normal executor config

        Returns:
            True if successful, False otherwise
        """
        task_id = task.id

        try:
            request.skip_git_clone = False
            request.executor_name = None
            request.executor_namespace = None

            executor, error = await self._prepare_executor(request, False)

            if error or not executor:
                logger.error(
                    f"[RecoveryService] Failed to prepare executor for task {task_id}: {error}"
                )
                if error:
                    self._persist_recovery_failure(db, subtask, task, error)
                return False

            executor_name = executor.container_name
            executor_namespace = self._resolve_executor_namespace(
                sandbox=executor,
                previous_namespace=subtask.executor_namespace,
            )

            # Set executor info in request for caller to use
            # Note: We do NOT update the subtask here - caller should update
            # the current subtask with this info to preserve history
            request.executor_name = executor_name
            request.executor_namespace = executor_namespace

            logger.info(
                f"[RecoveryService] Successfully recovered task {task_id} without archive, "
                f"executor={executor_namespace}/{executor_name}"
            )

            return True

        except Exception as e:
            logger.error(
                f"[RecoveryService] Error recovering without archive for task {task_id}: {e}",
                exc_info=True,
            )
            return False

    async def _prepare_executor(
        self,
        request: ExecutionRequest,
        skip_git_clone: bool,
    ):
        """Prepare a normal executor runtime without initial dispatch.

        Args:
            request: Execution request carrying the normal executor config
            skip_git_clone: Whether to skip git clone

        Returns:
            Tuple of (executor runtime, error_message)
        """
        from app.services.execution import get_executor_runtime_client

        runtime_client = get_executor_runtime_client()
        request.skip_git_clone = skip_git_clone
        request.executor_name = None
        request.executor_namespace = None

        executor, error = await runtime_client.prepare_executor(
            request=request,
        )

        return executor, error


# Global service instance
recovery_service = ExecutorRecoveryService()
