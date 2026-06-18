# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task CRUD operations.

This module contains methods for creating, updating, deleting, and canceling tasks.
"""

import asyncio
import json as json_lib
import logging
from datetime import datetime
from typing import Any, Callable, Dict, Optional

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.core.config import settings
from app.models.kind import Kind
from app.models.project import Project
from app.models.subtask import SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task, Team, Workspace
from app.schemas.task import ArchivedTask, TaskCreate, TaskUpdate
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.readers.kinds import KindType, kindReader
from app.services.task_skill_selection import build_task_skill_labels
from app.services.task_status import (
    mark_task_deleted_payload,
    mark_task_pending_payload,
)
from app.stores.tasks.interfaces import TaskIdAllocationError

from .converters import convert_to_task_dict
from .helpers import create_subtasks

logger = logging.getLogger(__name__)


class TaskOperationsMixin:
    """Mixin class providing task CRUD operations."""

    def create_task_or_append(
        self,
        db: Session,
        *,
        obj_in: TaskCreate,
        user: User,
        task_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Create user Task using kinds table.
        """
        logger.info(
            f"create_task_or_append called with task_id={task_id}, user_id={user.id}"
        )
        task = None
        team = None
        requested_task_id = task_id

        if task_id is None:
            task, team = self._create_new_task(db, obj_in, user, task_id=None)
        else:
            # Validate if task_id is valid
            if not self.validate_task_id(db, task_id, user_id=user.id):
                if task_stores.task_store.get_by_id(db, task_id=task_id) is not None:
                    raise HTTPException(status_code=404, detail="Task not found")
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid task_id: {task_id} does not exist in session",
                )

            # Check if already exists
            existing_task = task_stores.task_store.get_regular_active_task(
                db, task_id=task_id
            )
            if existing_task:
                if not task_stores.task_access_store.is_member(
                    db, task_id=existing_task.id, user_id=user.id
                ):
                    raise HTTPException(status_code=404, detail="Task not found")
                task, team = self._handle_existing_task(
                    db, existing_task, obj_in, user, task_id
                )
            else:
                existing_record = task_stores.task_store.get_by_id(
                    db,
                    task_id=task_id,
                    owner_user_id=user.id,
                )
                if requested_task_id is not None and (
                    existing_record is not None
                    and existing_record.kind != "Placeholder"
                ):
                    raise HTTPException(status_code=404, detail="Task not found")
                task, team = self._create_new_task(db, obj_in, user, task_id)

        # Create subtasks for the task
        create_subtasks(db, task, team, user.id, obj_in.prompt)

        db.commit()
        db.refresh(task)

        # Push mode: dispatch task to executor_manager immediately after commit
        # Skip dispatch for device tasks - they are routed via WebSocket to local devices
        if obj_in.task_type != "task":
            from app.services.execution import schedule_dispatch

            schedule_dispatch(task.id)

        return convert_to_task_dict(task, db, user.id)

    def _handle_existing_task(
        self,
        db: Session,
        existing_task: TaskResource,
        obj_in: TaskCreate,
        user: User,
        task_id: int,
    ) -> tuple:
        """Handle appending to an existing task."""
        if existing_task.client_origin != obj_in.client_origin:
            raise HTTPException(status_code=404, detail="Task not found")

        task_crd = Task.model_validate(existing_task.json)
        task_status = task_crd.status.status if task_crd.status else "PENDING"

        if task_status == "RUNNING":
            raise HTTPException(
                status_code=400,
                detail="Task is still running, please wait for it to complete",
            )
        elif task_status in ["DELETE"]:
            raise HTTPException(
                status_code=400,
                detail=f"Task has {task_status.lower()}, please create a new task",
            )
        elif task_status not in [
            "COMPLETED",
            "FAILED",
            "CANCELLED",
            "PENDING_CONFIRMATION",
        ]:
            raise HTTPException(
                status_code=400,
                detail="Task is in progress, please wait for it to complete",
            )

        if (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("autoDeleteExecutor") == "true"
        ):
            raise HTTPException(
                status_code=400,
                detail="task already clear, please create a new task",
            )

        # Check expiration
        expire_hours = settings.APPEND_CHAT_TASK_EXPIRE_HOURS
        task_type = (
            task_crd.metadata.labels
            and task_crd.metadata.labels.get("taskType")
            or "chat"
        )
        if task_type == "code":
            expire_hours = settings.APPEND_CODE_TASK_EXPIRE_HOURS

        task_shell_source = (
            task_crd.metadata.labels and task_crd.metadata.labels.get("source") or None
        )
        if task_shell_source != "chat_shell":
            if (
                datetime.now() - existing_task.updated_at
            ).total_seconds() > expire_hours * 3600:
                raise HTTPException(
                    status_code=400,
                    detail=f"{task_type} task has expired. You can only append tasks within {expire_hours} hours after last update.",
                )

        # Get team reference
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace

        is_group_member = task_stores.task_access_store.is_member(
            db, task_id=task_id, user_id=user.id
        )

        if is_group_member:
            team = kindReader.get_by_name_and_namespace(
                db, existing_task.user_id, KindType.TEAM, team_namespace, team_name
            )
        else:
            team = kindReader.get_by_name_and_namespace(
                db, user.id, KindType.TEAM, team_namespace, team_name
            )

        if not team:
            raise HTTPException(
                status_code=404,
                detail=f"Team '{team_name}' not found, it may be deleted or not shared",
            )

        task_stores.task_store.update_json(
            db,
            task=existing_task,
            payload=mark_task_pending_payload(existing_task.json),
        )

        return existing_task, team

    def _create_new_task(
        self,
        db: Session,
        obj_in: TaskCreate,
        user: User,
        task_id: int,
    ) -> tuple:
        """Create a new task."""
        # Validate team exists
        team = self._get_team_for_new_task(db, obj_in, user)

        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found, it may be deleted or not shared",
            )

        if obj_in.project_id:
            project_exists = (
                db.query(Project.id)
                .filter(
                    Project.id == obj_in.project_id,
                    Project.user_id == user.id,
                    Project.client_origin == obj_in.client_origin,
                    Project.is_active == True,
                )
                .first()
            )
            if not project_exists:
                raise HTTPException(status_code=404, detail="Project not found")

        # Validate prompt length
        if obj_in.prompt and len(obj_in.prompt.encode("utf-8")) > 60000:
            raise HTTPException(
                status_code=400,
                detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding.",
            )

        # Generate title
        title = obj_in.title
        if not title and obj_in.prompt:
            title = obj_in.prompt[:50]
            if len(obj_in.prompt) > 50:
                title += "..."

        if task_id is None:
            return self._create_new_task_with_allocated_pair(
                db=db,
                obj_in=obj_in,
                user=user,
                team=team,
                title=title,
            )

        return self._create_new_task_with_preallocated_id(
            db=db,
            obj_in=obj_in,
            user=user,
            team=team,
            task_id=task_id,
            title=title,
        )

    def _create_new_task_with_allocated_pair(
        self,
        *,
        db: Session,
        obj_in: TaskCreate,
        user: User,
        team: Kind,
        title: Optional[str],
    ) -> tuple:
        """Create a task and workspace through the Store allocation boundary."""

        def workspace_factory(task_id_value: int) -> tuple[str, str, dict[str, Any]]:
            workspace_name = f"workspace-{task_id_value}"
            return (
                workspace_name,
                "default",
                self._build_workspace_json(obj_in, workspace_name),
            )

        task, _workspace = (
            task_stores.task_store.create_pending_task_shell_with_workspace(
                db,
                user_id=user.id,
                client_origin=obj_in.client_origin,
                workspace_factory=workspace_factory,
                project_id=obj_in.project_id or 0,
            )
        )
        task_id = task.id
        task_json = self._build_task_json(
            obj_in=obj_in,
            team=team,
            task_id=task_id,
            title=title,
        )
        task_stores.task_store.update_fields(
            db,
            task=task,
            name=f"task-{task_id}",
            namespace="default",
            project_id=obj_in.project_id or 0,
            client_origin=obj_in.client_origin,
        )
        task_stores.task_store.update_json(db, task=task, payload=task_json)
        return task, team

    def _create_new_task_with_preallocated_id(
        self,
        *,
        db: Session,
        obj_in: TaskCreate,
        user: User,
        team: Kind,
        task_id: int,
        title: Optional[str],
    ) -> tuple:
        """Create a task from an already reserved task id."""
        workspace_name = f"workspace-{task_id}"
        task_stores.task_store.create_workspace(
            db,
            user_id=user.id,
            name=workspace_name,
            namespace="default",
            payload=self._build_workspace_json(obj_in, workspace_name),
            client_origin=obj_in.client_origin,
        )

        task = task_stores.task_store.create_task(
            db,
            task_id=task_id,
            user_id=user.id,
            name=f"task-{task_id}",
            namespace="default",
            payload=self._build_task_json(
                obj_in=obj_in,
                team=team,
                task_id=task_id,
                title=title,
            ),
            project_id=obj_in.project_id or 0,
            client_origin=obj_in.client_origin,
        )
        return task, team

    def _build_workspace_json(
        self, obj_in: TaskCreate, workspace_name: str
    ) -> dict[str, Any]:
        return {
            "kind": "Workspace",
            "spec": {
                "repository": {
                    "gitUrl": obj_in.git_url,
                    "gitRepo": obj_in.git_repo,
                    "gitRepoId": obj_in.git_repo_id,
                    "gitDomain": obj_in.git_domain,
                    "branchName": obj_in.branch_name,
                }
            },
            "status": {"state": "Available"},
            "metadata": {"name": workspace_name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

    def _build_task_json(
        self,
        *,
        obj_in: TaskCreate,
        team: Kind,
        task_id: int,
        title: Optional[str],
    ) -> dict[str, Any]:
        workspace_name = f"workspace-{task_id}"
        return {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": obj_in.prompt,
                "teamRef": {
                    "name": team.name,
                    "namespace": team.namespace,
                    "user_id": team.user_id,
                },
                "workspaceRef": {"name": workspace_name, "namespace": "default"},
            },
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "result": None,
                "errorMessage": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": None,
            },
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default",
                "labels": {
                    "type": obj_in.type,
                    "taskType": obj_in.task_type,
                    "autoDeleteExecutor": obj_in.auto_delete_executor,
                    "source": obj_in.source,
                    **(
                        {"projectId": str(obj_in.project_id)}
                        if obj_in.project_id
                        else {}
                    ),
                    **({"is_api_call": "true"} if obj_in.source == "api" else {}),
                    **({"modelId": obj_in.model_id} if obj_in.model_id else {}),
                    **(
                        {"forceOverrideBotModel": "true"}
                        if obj_in.force_override_bot_model
                        else {}
                    ),
                    **(
                        {
                            "forceOverrideBotModelType": obj_in.force_override_bot_model_type
                        }
                        if obj_in.force_override_bot_model_type
                        else {}
                    ),
                    **(
                        {"modelOptions": json_lib.dumps(obj_in.model_options)}
                        if obj_in.model_options
                        else {}
                    ),
                    **(
                        {"api_key_name": obj_in.api_key_name}
                        if obj_in.api_key_name
                        else {}
                    ),
                    **(build_task_skill_labels(obj_in.additional_skills)),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

    def _get_team_for_new_task(
        self, db: Session, obj_in: TaskCreate, user: User
    ) -> Optional[Kind]:
        """Get team for a new task."""
        if obj_in.team_id:
            from app.services.share.team_share_service import team_share_service

            return team_share_service.get_resource(db, obj_in.team_id, user.id)
        elif obj_in.team_name and obj_in.team_namespace:
            return kindReader.get_by_name_and_namespace(
                db, user.id, KindType.TEAM, obj_in.team_namespace, obj_in.team_name
            )
        return None

    def update_task(
        self,
        db: Session,
        *,
        task_id: int,
        obj_in: TaskUpdate,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Update user Task.
        """
        task = task_stores.task_store.get_owned_active_task(
            db,
            task_id=task_id,
            user_id=user_id,
            client_origin=client_origin,
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Validate prompt length
        if obj_in.prompt is not None and len(obj_in.prompt.encode("utf-8")) > 60000:
            raise HTTPException(
                status_code=400,
                detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding.",
            )

        update_data = obj_in.model_dump(exclude_unset=True)
        task_crd = Task.model_validate(task.json)

        # Update task spec fields
        if "title" in update_data:
            task_crd.spec.title = update_data["title"]
        if "prompt" in update_data:
            task_crd.spec.prompt = update_data["prompt"]

        # Update task status fields
        if task_crd.status:
            self._update_task_status(task_crd, update_data, task_id)

        # Update workspace if git-related fields are provided
        self._update_workspace_if_needed(db, task_crd, update_data, user_id)

        # Update timestamps
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()
            if "status" in update_data and update_data["status"] in [
                "COMPLETED",
                "FAILED",
                "CANCELLED",
            ]:
                task_crd.status.completedAt = datetime.now()

        task_stores.task_store.update_json(
            db, task=task, payload=task_crd.model_dump(mode="json", exclude_none=True)
        )

        db.commit()
        db.refresh(task)

        return convert_to_task_dict(task, db, user_id)

    def _update_task_status(
        self, task_crd: Task, update_data: Dict[str, Any], task_id: int
    ) -> None:
        """Update task status with state transition protection."""
        if "status" in update_data:
            new_status = (
                update_data["status"].value
                if hasattr(update_data["status"], "value")
                else update_data["status"]
            )
            current_status = task_crd.status.status

            final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]
            non_final_states = ["PENDING", "RUNNING", "CANCELLING"]

            if current_status == "CANCELLING":
                if new_status not in ["CANCELLED", "FAILED"]:
                    logger.warning(
                        f"Task {task_id}: Ignoring status update from CANCELLING to {new_status}."
                    )
                else:
                    task_crd.status.status = new_status
                    logger.info(
                        f"Task {task_id}: Status updated from CANCELLING to {new_status}"
                    )
            elif current_status in final_states and new_status in non_final_states:
                logger.warning(
                    f"Task {task_id}: Ignoring status update from final state {current_status} to non-final state {new_status}"
                )
            else:
                task_crd.status.status = new_status

        if "progress" in update_data:
            task_crd.status.progress = update_data["progress"]
        if "result" in update_data:
            task_crd.status.result = update_data["result"]
        if "error_message" in update_data:
            task_crd.status.errorMessage = update_data["error_message"]

    def _update_workspace_if_needed(
        self,
        db: Session,
        task_crd: Task,
        update_data: Dict[str, Any],
        user_id: int,
    ) -> None:
        """Update workspace if git-related fields are provided."""
        git_fields = ["git_url", "git_repo", "git_repo_id", "git_domain", "branch_name"]
        if not any(field in update_data for field in git_fields):
            return

        workspace = task_stores.task_store.get_workspace_by_ref(
            db,
            user_id=user_id,
            name=task_crd.spec.workspaceRef.name,
            namespace=task_crd.spec.workspaceRef.namespace,
        )

        if workspace:
            workspace_crd = Workspace.model_validate(workspace.json)

            if "git_url" in update_data:
                workspace_crd.spec.repository.gitUrl = update_data["git_url"]
            if "git_repo" in update_data:
                workspace_crd.spec.repository.gitRepo = update_data["git_repo"]
            if "git_repo_id" in update_data:
                workspace_crd.spec.repository.gitRepoId = update_data["git_repo_id"]
            if "git_domain" in update_data:
                workspace_crd.spec.repository.gitDomain = update_data["git_domain"]
            if "branch_name" in update_data:
                workspace_crd.spec.repository.branchName = update_data["branch_name"]

            task_stores.task_store.update_json(
                db, task=workspace, payload=workspace_crd.model_dump()
            )

    def delete_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> None:
        """
        Delete user Task and handle running subtasks.
        """
        logger.info(f"Deleting task with id: {task_id}")
        from app.core.async_utils import execute_async_safely
        from app.services.execution import get_executor_runtime_client

        # Preserve the existing OpenAPI delete response contract: deletion is
        # keyed by task id, while archived tasks are also accepted.
        task = task_stores.task_store.get_active_or_archived_task(
            db, task_id=task_id, client_origin=client_origin
        )

        if task and task.user_id != user_id:
            task = self._handle_member_leave(
                db, task_id, user_id, client_origin=client_origin
            )
            if task is None:
                return
        elif not task:
            task = self._handle_member_leave(
                db, task_id, user_id, client_origin=client_origin
            )
            if task is None:
                return  # User left the group chat

        # Get all subtasks for the task
        task_subtasks = task_stores.subtask_store.list_by_task_unfiltered(
            db,
            task_id=task_id,
            owner_user_id=task.user_id,
        )
        logger.info(
            "[delete_task] Loaded subtasks for runtime cleanup task_id=%s owner_user_id=%s count=%s",
            task_id,
            task.user_id,
            len(task_subtasks),
        )
        for subtask in task_subtasks:
            logger.info(
                "[delete_task] Subtask runtime ref task_id=%s subtask_id=%s status=%s role=%s "
                "executor_namespace=%s executor_name=%s executor_deleted_at=%s",
                task_id,
                subtask.id,
                subtask.status,
                subtask.role,
                subtask.executor_namespace,
                subtask.executor_name,
                subtask.executor_deleted_at,
            )

        # Collect unique executor keys and device IDs
        unique_executor_keys = set()
        device_ids = set()
        for subtask in task_subtasks:
            if subtask.executor_name and not subtask.executor_deleted_at:
                # Check if this is a device task
                if subtask.executor_name.startswith("device-"):
                    # Extract device_id from executor_name (format: "device-{device_id}")
                    device_id = subtask.executor_name[7:]  # Remove "device-" prefix
                    device_ids.add(device_id)
                else:
                    unique_executor_keys.add(
                        (subtask.executor_namespace, subtask.executor_name)
                    )
        logger.info(
            "[delete_task] Runtime cleanup targets task_id=%s executors=%s devices=%s",
            task_id,
            sorted(unique_executor_keys),
            sorted(device_ids),
        )

        runtime_client = get_executor_runtime_client()
        sandbox_lookup = execute_async_safely(
            runtime_client.get_sandbox,
            str(task_id),
            timeout=30.0,
        )
        sandbox_payload = None
        sandbox_lookup_error = None
        if sandbox_lookup is None:
            sandbox_lookup_error = "sandbox lookup failed"
        else:
            sandbox_payload, sandbox_lookup_error = sandbox_lookup

        cleanup_mode = "sandbox" if sandbox_payload is not None else "executor"
        if sandbox_lookup_error:
            cleanup_mode = "fallback"
        logger.info(
            "[delete_task] Runtime cleanup mode resolved for task_id=%s mode=%s sandbox_lookup_error=%s",
            task_id,
            cleanup_mode,
            sandbox_lookup_error,
        )

        if cleanup_mode in {"sandbox", "fallback"}:
            sandbox_delete_result = execute_async_safely(
                runtime_client.delete_sandbox,
                str(task_id),
                timeout=180.0,
            )
            sandbox_deleted = False
            sandbox_delete_error = "sandbox delete failed"
            if sandbox_delete_result is not None:
                sandbox_deleted, sandbox_delete_error = sandbox_delete_result

            if sandbox_deleted:
                logger.info(
                    "[delete_task] Sandbox runtime cleanup succeeded for task_id=%s",
                    task_id,
                )
            else:
                logger.info(
                    "[delete_task] Sandbox runtime cleanup skipped or failed for task_id=%s error=%s",
                    task_id,
                    sandbox_delete_error,
                )

        if cleanup_mode in {"executor", "fallback"}:
            # Stop running subtasks on executor
            if not unique_executor_keys:
                logger.info(
                    "[delete_task] No executor cleanup targets found for task_id=%s mode=%s",
                    task_id,
                    cleanup_mode,
                )
            for executor_namespace, executor_name in unique_executor_keys:
                try:
                    logger.info(
                        f"deleting task - delete_executor_task ns={executor_namespace} name={executor_name}"
                    )
                    executor_kinds_service.delete_executor_task_sync(
                        executor_name, executor_namespace
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to delete executor task ns={executor_namespace} name={executor_name}: {str(e)}"
                    )

        # Close device sessions for device tasks
        for device_id in device_ids:
            try:
                logger.info(
                    f"deleting task - sending close-session to device: device_id={device_id}, task_id={task_id}"
                )
                # Send close-session event to device via WebSocket
                # Use the same pattern as memory cleanup to handle async operation
                self._schedule_close_session_to_device(user_id, device_id, task_id)
            except Exception as e:
                logger.warning(
                    f"Failed to send close-session to device {device_id}: {str(e)}"
                )

        # Update all subtasks to DELETE status
        task_stores.subtask_store.mark_task_subtasks_deleted(
            db,
            task_id=task_id,
            owner_user_id=task.user_id,
        )

        # Update task status to DELETE
        task_stores.task_store.soft_delete_task(
            db,
            task=task,
            payload=mark_task_deleted_payload(task.json),
        )

        # Clean up long-term memories associated with this task (fire-and-forget)
        # This runs in background and doesn't block task deletion
        self._cleanup_task_memories(task.user_id, task_id)

        db.commit()

    def list_archived_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        client_origin: Optional[str] = None,
    ) -> tuple[list[ArchivedTask], int]:
        """List archived chats owned by a user."""

        tasks, total = task_stores.task_store.list_archived_tasks(
            db,
            user_id=user_id,
            skip=skip,
            limit=limit,
            client_origin=client_origin,
        )
        project_names = self._get_project_names(db, [task.project_id for task in tasks])
        return [self._to_archived_task(task, project_names) for task in tasks], total

    def archive_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> None:
        """Archive a single chat without deleting its runtime data."""

        task = self._get_owned_task_for_archive(
            db,
            task_id=task_id,
            user_id=user_id,
            state=TaskResource.STATE_ACTIVE,
            client_origin=client_origin,
        )
        self._set_task_archive_state(db, task, TaskResource.STATE_ARCHIVED)

    def unarchive_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> None:
        """Restore a single archived chat to normal chat lists."""

        task = self._get_owned_task_for_archive(
            db,
            task_id=task_id,
            user_id=user_id,
            state=TaskResource.STATE_ARCHIVED,
            client_origin=client_origin,
        )
        self._set_task_archive_state(db, task, TaskResource.STATE_ACTIVE)

    def archive_all_user_chats(
        self, db: Session, *, user_id: int, client_origin: Optional[str] = None
    ) -> int:
        """Archive all active personal chat/code tasks owned by a user."""

        tasks = task_stores.task_store.list_archivable_active_tasks(
            db,
            user_id=user_id,
            scope="all",
            client_origin=client_origin,
        )
        return self._archive_tasks(db, tasks)

    def archive_standalone_chats(
        self, db: Session, *, user_id: int, client_origin: Optional[str] = None
    ) -> int:
        """Archive all active chat/code tasks that are not associated with projects."""

        tasks = task_stores.task_store.list_archivable_active_tasks(
            db,
            user_id=user_id,
            scope="standalone",
            client_origin=client_origin,
        )
        return self._archive_tasks(db, tasks)

    def archive_all_project_chats(
        self, db: Session, *, user_id: int, client_origin: Optional[str] = None
    ) -> int:
        """Archive all active chat/code tasks associated with any project."""

        tasks = task_stores.task_store.list_archivable_active_tasks(
            db,
            user_id=user_id,
            scope="project",
            client_origin=client_origin,
        )
        return self._archive_tasks(db, tasks)

    def archive_project_chats(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> int:
        """Archive all active chats in a project owned by a user."""

        tasks = task_stores.task_store.list_archivable_active_tasks(
            db,
            user_id=user_id,
            scope="project_id",
            project_id=project_id,
            client_origin=client_origin,
        )
        return self._archive_tasks(db, tasks)

    def delete_all_archived_tasks(
        self, db: Session, *, user_id: int, client_origin: Optional[str] = None
    ) -> int:
        """Soft delete every archived chat owned by a user."""

        task_ids = task_stores.task_store.list_archived_task_ids(
            db, user_id=user_id, client_origin=client_origin
        )
        for task_id in task_ids:
            self.delete_task(
                db=db, task_id=task_id, user_id=user_id, client_origin=client_origin
            )
        return len(task_ids)

    def _archive_tasks(self, db: Session, tasks: list[TaskResource]) -> int:
        archived_count = 0
        for task in tasks:
            if not self._is_archivable_chat(task):
                continue
            self._set_task_archive_state(
                db, task, TaskResource.STATE_ARCHIVED, commit=False
            )
            archived_count += 1
        if archived_count:
            db.commit()
        return archived_count

    def _set_task_archive_state(
        self,
        db: Session,
        task: TaskResource,
        state: int,
        *,
        commit: bool = True,
    ) -> None:
        task_stores.task_store.set_archive_state(
            db, task=task, state=state, commit=commit
        )

    def _get_owned_task_for_archive(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        state: int,
        client_origin: Optional[str] = None,
    ) -> TaskResource:
        task = task_stores.task_store.get_owned_task_by_state(
            db,
            task_id=task_id,
            user_id=user_id,
            state=state,
            client_origin=client_origin,
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if not self._is_archivable_chat(task):
            raise HTTPException(status_code=400, detail="Task cannot be archived")
        return task

    def _is_archivable_chat(self, task: TaskResource) -> bool:
        task_json = task.json or {}
        metadata = task_json.get("metadata") or {}
        labels = metadata.get("labels") or {}
        if labels.get("type") == "subscription":
            return False
        return labels.get("taskType", "chat") in {"chat", "code"}

    def _get_project_names(self, db: Session, project_ids: list[int]) -> dict[int, str]:
        ids = sorted({project_id for project_id in project_ids if project_id})
        if not ids:
            return {}
        projects = db.query(Project).filter(Project.id.in_(ids)).all()
        return {project.id: project.name for project in projects}

    def _to_archived_task(
        self, task: TaskResource, project_names: dict[int, str]
    ) -> ArchivedTask:
        task_crd = Task.model_validate(task.json)
        labels = task_crd.metadata.labels or {}
        return ArchivedTask(
            id=task.id,
            title=task_crd.spec.title,
            status=task_crd.status.status if task_crd.status else "PENDING",
            task_type=labels.get("taskType", "chat"),
            type=labels.get("type", "online"),
            created_at=task.created_at,
            updated_at=task.updated_at,
            completed_at=task_crd.status.completedAt if task_crd.status else None,
            project_id=task.project_id or 0,
            client_origin=task.client_origin,
            project_name=project_names.get(task.project_id or 0),
        )

    def _handle_member_leave(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        """Handle a member leaving a group chat using ResourceMember."""
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        task = task_stores.task_store.get_active_task(
            db, task_id=task_id, client_origin=client_origin
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        task_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .first()
        )

        if not task_member:
            raise HTTPException(status_code=404, detail="Task not found")

        # User is a member, not owner - handle as "leave group chat"
        logger.info(f"User {user_id} leaving group chat task {task_id}")
        task_member.status = MemberStatus.REJECTED
        task_member.reviewed_at = datetime.now()
        db.commit()
        return None

    async def cancel_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        background_task_runner: Optional[Callable] = None,
    ) -> Dict[str, Any]:
        """
        Cancel a running task or close session for completed device tasks.
        """
        # Verify user owns this task
        task_dict = self.get_task_detail(db=db, task_id=task_id, user_id=user_id)
        if not task_dict:
            raise HTTPException(status_code=404, detail="Task not found")

        current_status = task_dict.get("status", "")
        final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]

        # Task is already in final state, cannot cancel
        if current_status in final_states:
            logger.warning(
                f"Task {task_id} is already in final state {current_status}, cannot cancel"
            )
            raise HTTPException(
                status_code=400,
                detail=f"Task is already {current_status.lower()}, cannot cancel",
            )

        if current_status == "CANCELLING":
            logger.info(f"Task {task_id} is already being cancelled")
            return {
                "message": "Task is already being cancelled",
                "status": "CANCELLING",
            }

        # Check if this is a Chat Shell task
        is_chat_shell = self._is_chat_shell_task(db, task_id)
        logger.info(f"Task {task_id} is_chat_shell={is_chat_shell}")

        if is_chat_shell:
            return await self._cancel_chat_shell_task(
                db, task_id, user_id, background_task_runner
            )
        else:
            return await self._cancel_executor_task(
                db, task_id, user_id, background_task_runner
            )

    def _is_chat_shell_task(self, db: Session, task_id: int) -> bool:
        """Check if a task is a Chat Shell task."""
        task_kind = task_stores.task_store.get_active_task(db, task_id=task_id)

        if task_kind and task_kind.json:
            task_crd = Task.model_validate(task_kind.json)
            if task_crd.metadata.labels:
                source = task_crd.metadata.labels.get("source", "")
                return source == "chat_shell"
        return False

    async def _cancel_chat_shell_task(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        background_task_runner: Optional[Callable],
    ) -> Dict[str, Any]:
        """Cancel a Chat Shell task."""
        running_subtask = task_stores.subtask_store.get_running_assistant_for_user(
            db, task_id=task_id, user_id=user_id
        )

        if running_subtask:
            if background_task_runner:
                background_task_runner(self._call_chat_shell_cancel, running_subtask.id)

            task_stores.subtask_store.update_fields(
                db,
                subtask=running_subtask,
                status=SubtaskStatus.CANCELLED,
                progress=100,
                completed_at=datetime.now(),
                error_message="",
            )
            db.commit()

            try:
                self.update_task(
                    db=db,
                    task_id=task_id,
                    obj_in=TaskUpdate(status="CANCELLED"),
                    user_id=user_id,
                )
                logger.info(
                    f"Chat Shell task {task_id} cancelled and marked as CANCELLED"
                )
            except Exception as e:
                logger.error(
                    f"Failed to update Chat Shell task {task_id} status: {str(e)}"
                )
            return {"message": "Chat stopped successfully", "status": "CANCELLED"}
        else:
            try:
                self.update_task(
                    db=db,
                    task_id=task_id,
                    obj_in=TaskUpdate(status="COMPLETED"),
                    user_id=user_id,
                )
            except Exception as e:
                logger.error(f"Failed to update task {task_id} status: {str(e)}")

            return {"message": "No running stream to cancel", "status": "COMPLETED"}

    async def _cancel_executor_task(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        background_task_runner: Optional[Callable],
    ) -> Dict[str, Any]:
        """Cancel an executor-based task."""
        try:
            self.update_task(
                db=db,
                task_id=task_id,
                obj_in=TaskUpdate(status="CANCELLED"),
                user_id=user_id,
            )
            logger.info(f"Task {task_id} status updated to CANCELLED by user {user_id}")
        except Exception as e:
            logger.error(
                f"Failed to update task {task_id} status to CANCELLED: {str(e)}"
            )
            raise HTTPException(
                status_code=500, detail=f"Failed to update task status: {str(e)}"
            ) from e

        if background_task_runner:
            background_task_runner(self._call_executor_cancel, task_id)

        return {"message": "Cancel request accepted", "status": "CANCELLED"}

    async def _call_executor_cancel(self, task_id: int):
        """Background task to call executor_manager cancel API."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    settings.EXECUTOR_CANCEL_TASK_URL,
                    json={"task_id": task_id},
                    timeout=60.0,
                )
                response.raise_for_status()
                logger.info(
                    f"Task {task_id} cancelled successfully via executor_manager"
                )
        except httpx.HTTPStatusError as e:
            response = e.response
            logger.error(
                "Error calling executor_manager to cancel task %s: "
                "status_code=%s body=%s",
                task_id,
                response.status_code,
                response.text[:1000],
            )
        except Exception as e:
            logger.error(
                f"Error calling executor_manager to cancel task {task_id}: {str(e)}"
            )

    async def _call_chat_shell_cancel(self, subtask_id: int):
        """Background task to cancel Chat Shell streaming."""
        try:
            from app.services.chat.storage import session_manager

            success = await session_manager.cancel_stream(subtask_id)
            if success:
                logger.info(
                    f"Chat Shell stream cancelled successfully for subtask {subtask_id}"
                )
            else:
                logger.warning(
                    f"Failed to cancel Chat Shell stream for subtask {subtask_id}"
                )
        except Exception as e:
            logger.error(
                f"Error cancelling Chat Shell stream for subtask {subtask_id}: {str(e)}"
            )

    def get_pipeline_stage_info(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
    ) -> Dict[str, Any]:
        """
        Get pipeline stage information for a task.
        """
        task = task_stores.task_store.get_active_task(db, task_id=task_id)

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        if not task_stores.task_access_store.is_member(
            db, task_id=task_id, user_id=user_id
        ):
            raise HTTPException(status_code=404, detail="Task not found")

        task_crd = Task.model_validate(task.json)

        team = pipeline_stage_service.get_team_for_task(db, task, task_crd)
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        team_crd = Team.model_validate(team.json)

        if team_crd.spec.collaborationModel != "pipeline":
            return {
                "current_stage": 0,
                "total_stages": 1,
                "current_stage_name": "default",
                "is_pending_confirmation": False,
                "stages": [],
            }

        return pipeline_stage_service.get_stage_info(db, task_id, team_crd)

    def create_task_id(self, db: Session, user_id: int) -> int:
        """
        Create new task id using tasks table auto increment.
        """
        try:
            return task_stores.task_store.create_placeholder_task_id(
                db, user_id=user_id
            )

        except TaskIdAllocationError as e:
            db.rollback()
            raise HTTPException(
                status_code=503, detail=f"Unable to allocate task ID: {str(e)}"
            ) from e
        except Exception as e:
            db.rollback()
            raise HTTPException(
                status_code=500, detail=f"Unable to allocate task ID: {str(e)}"
            ) from e

    def validate_task_id(
        self, db: Session, task_id: int, user_id: Optional[int] = None
    ) -> bool:
        """
        Validate that task_id is valid.

        Note: We no longer delete Placeholder records here. Instead, _create_new_task
        will update the existing Placeholder record to avoid SQLite UNIQUE constraint
        issues when re-inserting with the same ID.
        """
        return task_stores.task_store.is_valid_task_id(
            db, task_id=task_id, owner_user_id=user_id
        )

    def _cleanup_task_memories(self, user_id: int, task_id: int) -> None:
        """
        Clean up long-term memories associated with a task.

        This is a fire-and-forget operation that runs in background
        and doesn't block task deletion.

        Args:
            user_id: User ID who owns the task
            task_id: Task ID being deleted
        """
        import asyncio

        from app.services.memory import get_memory_manager

        memory_manager = get_memory_manager()
        if not memory_manager.is_enabled:
            return

        def _log_cleanup_exception(task_or_future):
            """Log any exceptions from cleanup task."""
            try:
                if hasattr(task_or_future, "exception"):
                    exc = task_or_future.exception()
                    if exc:
                        logger.error(
                            "[delete_task] Memory cleanup failed for task %d: %s",
                            task_id,
                            exc,
                            exc_info=exc,
                        )
            except Exception:
                logger.exception("[delete_task] Error checking cleanup task status")

        # Try to get the running event loop
        try:
            loop = asyncio.get_running_loop()
            cleanup_task = loop.create_task(
                memory_manager.cleanup_task_memories(
                    user_id=str(user_id), task_id=str(task_id)
                )
            )
            cleanup_task.add_done_callback(_log_cleanup_exception)
            logger.info(
                "[delete_task] Started background task to cleanup memories for task %d",
                task_id,
            )
        except RuntimeError:
            # No event loop running - try to schedule on main loop
            try:
                from app.services.chat.webpage_ws_chat_emitter import (
                    get_main_event_loop,
                )

                main_loop = get_main_event_loop()
                if main_loop and main_loop.is_running():
                    future = asyncio.run_coroutine_threadsafe(
                        memory_manager.cleanup_task_memories(
                            user_id=str(user_id), task_id=str(task_id)
                        ),
                        main_loop,
                    )
                    future.add_done_callback(_log_cleanup_exception)
                    logger.info(
                        "[delete_task] Scheduled memory cleanup on main loop for task %d",
                        task_id,
                    )
                else:
                    logger.warning(
                        "[delete_task] Cannot cleanup memories: no running event loop"
                    )
            except Exception as e:
                logger.warning("[delete_task] Failed to schedule memory cleanup: %s", e)

    async def _send_close_session_to_device_async(
        self, user_id: int, device_id: str, task_id: int
    ) -> None:
        """
        Send close-session event to a device via WebSocket (async implementation).

        This is called when deleting a task to ensure the device session
        is properly closed and the device slot is freed.

        Args:
            user_id: User ID who owns the task
            device_id: Device ID to send the event to
            task_id: Task ID being deleted
        """
        try:
            device_room = f"device:{user_id}:{device_id}"

            logger.info(
                f"[delete_task] Sending task:close-session to device: "
                f"device_id={device_id}, room={device_room}, task_id={task_id}"
            )

            from app.core.socketio import get_sio

            sio = get_sio()
            await sio.emit(
                "task:close-session",
                {"task_id": task_id},
                room=device_room,
                namespace="/local-executor",
            )

            logger.info(
                f"[delete_task] Successfully sent task:close-session to device for task_id={task_id}"
            )

        except Exception as e:
            logger.error(
                f"[delete_task] Failed to send close-session to device {device_id}: {str(e)}",
                exc_info=True,
            )

    def _schedule_close_session_to_device(
        self, user_id: int, device_id: str, task_id: int
    ) -> None:
        """
        Schedule sending close-session event to a device.

        This is a fire-and-forget operation that runs in background
        and doesn't block task deletion.

        Args:
            user_id: User ID who owns the task
            device_id: Device ID to send the event to
            task_id: Task ID being deleted
        """
        import asyncio

        def _log_close_session_exception(task_or_future):
            """Log any exceptions from close-session task."""
            try:
                if hasattr(task_or_future, "exception"):
                    exc = task_or_future.exception()
                    if exc:
                        logger.error(
                            "[delete_task] Close-session failed for device %s, task %d: %s",
                            device_id,
                            task_id,
                            exc,
                            exc_info=exc,
                        )
            except Exception:
                logger.exception(
                    "[delete_task] Error checking close-session task status"
                )

        # Try to get the running event loop
        try:
            loop = asyncio.get_running_loop()
            close_session_task = loop.create_task(
                self._send_close_session_to_device_async(user_id, device_id, task_id)
            )
            close_session_task.add_done_callback(_log_close_session_exception)
            logger.info(
                "[delete_task] Started background task to close device session for task %d, device %s",
                task_id,
                device_id,
            )
        except RuntimeError:
            # No event loop running - try to schedule on main loop
            try:
                from app.services.chat.webpage_ws_chat_emitter import (
                    get_main_event_loop,
                )

                main_loop = get_main_event_loop()
                if main_loop and main_loop.is_running():
                    future = asyncio.run_coroutine_threadsafe(
                        self._send_close_session_to_device_async(
                            user_id, device_id, task_id
                        ),
                        main_loop,
                    )
                    future.add_done_callback(_log_close_session_exception)
                    logger.info(
                        "[delete_task] Scheduled close-session on main loop for task %d, device %s",
                        task_id,
                        device_id,
                    )
                else:
                    logger.warning(
                        "[delete_task] Cannot send close-session: no running event loop"
                    )
            except Exception as e:
                logger.warning("[delete_task] Failed to schedule close-session: %s", e)

    def set_preserve_executor(
        self, db: Session, *, task_id: int, user_id: int, preserve: bool
    ) -> Dict[str, Any]:
        """
        Set or cancel the preserve executor flag for a task.

        When preserve=True, the executor pod for this task will not be cleaned up
        by the cleanup_stale_executors job even after the task is completed.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID requesting the change
            preserve: True to preserve executor, False to allow normal cleanup

        Returns:
            Dict with task_id and preserve_executor status

        Raises:
            HTTPException: If task not found or user doesn't have permission
        """
        from app.services.task_member_service import task_member_service

        # Check if user is a member of this task (owner or group member)
        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(
                status_code=404, detail="Task not found or no permission"
            )

        task = task_stores.task_store.get_active_task(db, task_id=task_id)

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        task_crd = Task.model_validate(task.json)

        # Initialize labels if not exists
        if task_crd.metadata.labels is None:
            task_crd.metadata.labels = {}

        # Set the preserveExecutor label (use "true"/"false" for consistency with autoDeleteExecutor)
        if preserve:
            task_crd.metadata.labels["preserveExecutor"] = "true"
            logger.info(
                f"[set_preserve_executor] User {user_id} set preserveExecutor=true for task {task_id}"
            )
        else:
            task_crd.metadata.labels["preserveExecutor"] = "false"
            logger.info(
                f"[set_preserve_executor] User {user_id} set preserveExecutor=false for task {task_id}"
            )

        # Save changes
        task_stores.task_store.update_json(
            db, task=task, payload=task_crd.model_dump(mode="json", exclude_none=True)
        )

        db.commit()
        db.refresh(task)

        return {
            "task_id": task_id,
            "preserve_executor": preserve,
            "message": (
                "Executor will be preserved for this task"
                if preserve
                else "Executor cleanup enabled for this task"
            ),
        }
