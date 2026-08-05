# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Workspace archive helpers for task-backed sandbox runtimes."""

import logging
from copy import deepcopy
from typing import Any, Optional, Protocol, Tuple

from sqlalchemy.orm import Session

from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.services.workspace_archive import archive_service

logger = logging.getLogger(__name__)


class SandboxRuntimeClient(Protocol):
    """Runtime operations needed by sandbox archive orchestration."""

    async def get_sandbox(self, sandbox_id: str):
        """Return sandbox payload and error string."""


class SandboxWorkspaceArchiveService:
    """Apply the existing workspace archive pipeline to sandbox runtimes."""

    def __init__(self, runtime_client: Optional[SandboxRuntimeClient] = None):
        """Initialize the service with an optional runtime client."""
        self._runtime_client = runtime_client

    def _get_runtime_client(self) -> SandboxRuntimeClient:
        """Resolve the runtime client lazily to avoid import cycles."""
        if self._runtime_client is not None:
            return self._runtime_client

        from app.services.execution import get_executor_runtime_client

        return get_executor_runtime_client()

    def _load_task(self, db: Session, task_id: int) -> Optional[TaskResource]:
        """Load an active Task resource for archive metadata access."""
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.in_(TaskResource.is_active_query()),
            )
            .first()
        )

    def _load_latest_subtask(self, db: Session, task_id: int) -> Optional[Subtask]:
        """Load a representative subtask for archive service metadata."""
        return (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id)
            .order_by(Subtask.id.desc())
            .first()
        )

    def prepare_restore_metadata(
        self,
        db: Session,
        metadata: Optional[dict[str, Any]],
    ) -> Tuple[dict[str, Any], Optional[TaskResource]]:
        """Return sandbox metadata updated for archive restore when possible."""
        sandbox_metadata = deepcopy(metadata) if metadata else {}
        task_id = self._parse_task_id(sandbox_metadata.get("task_id"))
        if task_id is None:
            return sandbox_metadata, None

        task = self._load_task(db, task_id)
        if not task:
            return sandbox_metadata, None

        archive_available, _, reason = archive_service.check_archive_available(task)
        if reason == "expired":
            logger.warning(
                "[SandboxWorkspaceArchive] Archive expired for sandbox task %s",
                task_id,
            )
            return sandbox_metadata, None

        if not archive_available:
            return sandbox_metadata, None

        sandbox_metadata["skip_git_clone"] = True
        return sandbox_metadata, task

    async def archive_sandbox_before_delete(
        self,
        db: Session,
        sandbox_id: str,
    ):
        """Archive a running task-backed sandbox before it is deleted."""
        task_id = self._parse_task_id(sandbox_id)
        if task_id is None:
            return None

        runtime_client = self._get_runtime_client()
        sandbox_payload, error = await runtime_client.get_sandbox(sandbox_id)
        if error:
            logger.info(
                "[SandboxWorkspaceArchive] Sandbox lookup skipped archive: "
                "sandbox_id=%s error=%s",
                sandbox_id,
                error,
            )
            return None

        if not sandbox_payload or sandbox_payload.get("status") != "running":
            return None

        executor_name = sandbox_payload.get("container_name")
        if not executor_name:
            return None

        executor_namespace = sandbox_payload.get("executor_namespace") or "default"
        task = self._load_task(db, task_id)
        if not task:
            return None

        subtask = self._load_latest_subtask(db, task_id)
        if not subtask:
            return None

        archive_info = await archive_service.archive_workspace(
            db=db,
            subtask=subtask,
            task=task,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
        )
        if archive_info:
            db.commit()
        return archive_info

    async def restore_sandbox_after_create(
        self,
        db: Session,
        task: TaskResource,
        sandbox: object,
    ) -> bool:
        """Restore a task archive into a newly created sandbox runtime."""
        executor_name = getattr(sandbox, "container_name", None)
        if not executor_name:
            return False

        executor_namespace = getattr(sandbox, "executor_namespace", None) or "default"
        return await archive_service.restore_workspace(
            db=db,
            task=task,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
        )

    def _parse_task_id(self, value: Any) -> Optional[int]:
        """Parse a task id from sandbox metadata or sandbox id."""
        try:
            task_id = int(value)
        except (TypeError, ValueError):
            return None
        return task_id if task_id > 0 else None


sandbox_workspace_archive_service = SandboxWorkspaceArchiveService()
