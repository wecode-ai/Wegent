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
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task, Team, Workspace
from app.schemas.task import TaskCreate, TaskUpdate
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.readers.kinds import KindType, kindReader

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

        # Set task ID
        if task_id is None:
            task_id = self.create_task_id(db, user.id)

        # Validate if task_id is valid
        if not self.validate_task_id(db, task_id):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid task_id: {task_id} does not exist in session",
            )

        # Check if already exists
        existing_task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )
        if existing_task:
            task, team = self._handle_existing_task(
                db, existing_task, obj_in, user, task_id
            )
        else:
            task, team = self._create_new_task(db, obj_in, user, task_id)

        # Create subtasks for the task
        create_subtasks(db, task, team, user.id, obj_in.prompt)

        db.commit()
        db.refresh(task)

        # Push mode: dispatch task to executor_manager immediately after commit
        # Skip dispatch for device tasks - they are routed via WebSocket to local devices
        if obj_in.task_type != "task":
            from app.services.task_dispatcher import task_dispatcher

            task_dispatcher.schedule_dispatch(task.id)

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

        from app.services.task_member_service import task_member_service

        is_group_member = task_member_service.is_member(db, task_id, user.id)

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

        # Update existing task status to PENDING
        if task_crd.status:
            task_crd.status.status = "PENDING"
            task_crd.status.progress = 0
        existing_task.json = task_crd.model_dump(mode="json", exclude_none=True)
        existing_task.updated_at = datetime.now()

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

        # Create Workspace
        workspace_name = f"workspace-{task_id}"
        workspace_json = {
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

        workspace = TaskResource(
            user_id=user.id,
            kind="Workspace",
            name=workspace_name,
            namespace="default",
            json=workspace_json,
            is_active=True,
        )
        db.add(workspace)

        # Create Task JSON
        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": obj_in.prompt,
                "teamRef": {"name": team.name, "namespace": team.namespace},
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
                        {"api_key_name": obj_in.api_key_name}
                        if obj_in.api_key_name
                        else {}
                    ),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        task = TaskResource(
            id=task_id,
            user_id=user.id,
            kind="Task",
            name=f"task-{task_id}",
            namespace="default",
            json=task_json,
            is_active=True,
        )
        db.add(task)

        return task, team

    def _get_team_for_new_task(
        self, db: Session, obj_in: TaskCreate, user: User
    ) -> Optional[Kind]:
        """Get team for a new task."""
        if obj_in.team_id:
            team_by_id = kindReader.get_by_id(db, KindType.TEAM, obj_in.team_id)
            if team_by_id:
                team = kindReader.get_by_name_and_namespace(
                    db,
                    user.id,
                    KindType.TEAM,
                    team_by_id.namespace,
                    team_by_id.name,
                )
                if team and team.id != obj_in.team_id:
                    team = None
                return team
        elif obj_in.team_name and obj_in.team_namespace:
            return kindReader.get_by_name_and_namespace(
                db, user.id, KindType.TEAM, obj_in.team_namespace, obj_in.team_name
            )
        return None

    def update_task(
        self, db: Session, *, task_id: int, obj_in: TaskUpdate, user_id: int
    ) -> Dict[str, Any]:
        """
        Update user Task.
        """
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
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

        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        flag_modified(task, "json")

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

        workspace = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Workspace",
                TaskResource.name == task_crd.spec.workspaceRef.name,
                TaskResource.namespace == task_crd.spec.workspaceRef.namespace,
                TaskResource.is_active.is_(True),
            )
            .first()
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

            workspace.json = workspace_crd.model_dump()
            flag_modified(workspace, "json")

    def delete_task(self, db: Session, *, task_id: int, user_id: int) -> None:
        """
        Delete user Task and handle running subtasks.
        """
        logger.info(f"Deleting task with id: {task_id}")

        # First check if user is the task owner
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        # If not the owner, check if user is a group chat member
        if not task:
            task = self._handle_member_leave(db, task_id, user_id)
            if task is None:
                return  # User left the group chat

        # Get all subtasks for the task
        task_subtasks = db.query(Subtask).filter(Subtask.task_id == task_id).all()

        # Collect unique executor keys
        unique_executor_keys = set()
        for subtask in task_subtasks:
            if subtask.executor_name and not subtask.executor_deleted_at:
                unique_executor_keys.add(
                    (subtask.executor_namespace, subtask.executor_name)
                )

        # Stop running subtasks on executor
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

        # Update all subtasks to DELETE status
        db.query(Subtask).filter(Subtask.task_id == task_id).update(
            {
                Subtask.executor_deleted_at: True,
                Subtask.status: SubtaskStatus.DELETE,
                Subtask.updated_at: datetime.now(),
            }
        )

        # Update task status to DELETE
        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            task_crd.status.status = "DELETE"
            task_crd.status.updatedAt = datetime.now()
        task.json = task_crd.model_dump(mode="json", exclude_none=True)
        task.updated_at = datetime.now()
        task.is_active = False
        flag_modified(task, "json")

        # Clean up long-term memories associated with this task (fire-and-forget)
        # This runs in background and doesn't block task deletion
        self._cleanup_task_memories(task.user_id, task_id)

        db.commit()

    def _handle_member_leave(
        self, db: Session, task_id: int, user_id: int
    ) -> Optional[TaskResource]:
        """Handle a member leaving a group chat."""
        from app.models.task_member import MemberStatus, TaskMember

        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        task_member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.user_id == user_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not task_member:
            raise HTTPException(status_code=404, detail="Task not found")

        # User is a member, not owner - handle as "leave group chat"
        logger.info(f"User {user_id} leaving group chat task {task_id}")
        task_member.status = MemberStatus.REMOVED
        task_member.removed_at = datetime.now()
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
        Cancel a running task.
        """
        # Verify user owns this task
        task_dict = self.get_task_detail(db=db, task_id=task_id, user_id=user_id)
        if not task_dict:
            raise HTTPException(status_code=404, detail="Task not found")

        current_status = task_dict.get("status", "")
        final_states = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"]

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
        task_kind = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

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
        running_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == user_id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == SubtaskStatus.RUNNING,
            )
            .first()
        )

        if running_subtask:
            if background_task_runner:
                background_task_runner(self._call_chat_shell_cancel, running_subtask.id)

            running_subtask.status = SubtaskStatus.COMPLETED
            running_subtask.progress = 100
            running_subtask.completed_at = datetime.now()
            running_subtask.updated_at = datetime.now()
            running_subtask.error_message = ""
            db.commit()

            try:
                self.update_task(
                    db=db,
                    task_id=task_id,
                    obj_in=TaskUpdate(status="COMPLETED"),
                    user_id=user_id,
                )
                logger.info(
                    f"Chat Shell task {task_id} cancelled and marked as COMPLETED"
                )
            except Exception as e:
                logger.error(
                    f"Failed to update Chat Shell task {task_id} status: {str(e)}"
                )
            return {"message": "Chat stopped successfully", "status": "COMPLETED"}
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
                obj_in=TaskUpdate(status="CANCELLING"),
                user_id=user_id,
            )
            logger.info(
                f"Task {task_id} status updated to CANCELLING by user {user_id}"
            )
        except Exception as e:
            logger.error(
                f"Failed to update task {task_id} status to CANCELLING: {str(e)}"
            )
            raise HTTPException(
                status_code=500, detail=f"Failed to update task status: {str(e)}"
            ) from e

        if background_task_runner:
            background_task_runner(self._call_executor_cancel, task_id)

        return {"message": "Cancel request accepted", "status": "CANCELLING"}

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

    def confirm_pipeline_stage(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        confirmed_prompt: str,
        action: str = "continue",
    ) -> Dict[str, Any]:
        """
        Confirm a pipeline stage and proceed to the next stage.
        """
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        from app.services.task_member_service import task_member_service

        if not task_member_service.is_member(db, task_id, user_id):
            raise HTTPException(status_code=404, detail="Task not found")

        task_crd = Task.model_validate(task.json)

        current_status = task_crd.status.status if task_crd.status else "PENDING"
        if current_status != "PENDING_CONFIRMATION":
            raise HTTPException(
                status_code=400,
                detail=f"Task is not awaiting confirmation. Current status: {current_status}",
            )

        team = pipeline_stage_service.get_team_for_task(db, task, task_crd)
        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        team_crd = Team.model_validate(team.json)

        if team_crd.spec.collaborationModel != "pipeline":
            raise HTTPException(
                status_code=400,
                detail="Stage confirmation is only available for pipeline teams",
            )

        return pipeline_stage_service.confirm_stage(
            db=db,
            task=task,
            task_crd=task_crd,
            team_crd=team_crd,
            confirmed_prompt=confirmed_prompt,
            action=action,
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
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        from app.services.task_member_service import task_member_service

        if not task_member_service.is_member(db, task_id, user_id):
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
            existing_placeholder = db.execute(
                text(
                    """
                SELECT id FROM tasks
                WHERE user_id = :user_id AND kind = 'Placeholder' AND is_active = false
                LIMIT 1
            """
                ),
                {"user_id": user_id},
            ).fetchone()

            if existing_placeholder:
                return existing_placeholder[0]

            placeholder_json = {
                "kind": "Placeholder",
                "metadata": {"name": "temp-placeholder", "namespace": "default"},
                "spec": {},
                "status": {"state": "Reserved"},
            }

            result = db.execute(
                text(
                    """
                INSERT INTO tasks (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
                VALUES (:user_id, 'Placeholder', 'temp-placeholder', 'default', :json, false, NOW(), NOW())
            """
                ),
                {"user_id": user_id, "json": json_lib.dumps(placeholder_json)},
            )

            allocated_id = result.lastrowid
            if not allocated_id:
                raise Exception("Failed to get allocated ID")

            db.commit()

            return allocated_id

        except Exception as e:
            db.rollback()
            raise HTTPException(
                status_code=500, detail=f"Unable to allocate task ID: {str(e)}"
            ) from e

    def validate_task_id(self, db: Session, task_id: int) -> bool:
        """
        Validate that task_id is valid and clean up placeholder if exists.
        """
        existing_record = db.execute(
            text("SELECT kind FROM tasks WHERE id = :task_id"), {"task_id": task_id}
        ).fetchone()

        if existing_record:
            kind = existing_record[0]

            if kind == "Placeholder":
                db.execute(text("DELETE FROM tasks WHERE id = :id"), {"id": task_id})
                db.commit()
                return True

            return True

        return False

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
                from app.services.chat.ws_emitter import get_main_event_loop

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
