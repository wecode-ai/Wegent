# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task share service for unified resource sharing.

Provides Task-specific implementation of the UnifiedShareService.
Tasks have special copy behavior when shared.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.services.share.base_service import UnifiedShareService

logger = logging.getLogger(__name__)


class TaskShareService(UnifiedShareService):
    """
    Task-specific share service.

    Tasks are copied when shared - each member gets their own copy.
    This preserves the original task and allows independent editing.
    """

    def __init__(self):
        super().__init__(ResourceType.TASK)

    def _get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[TaskResource]:
        """
        Fetch Task resource.

        For Tasks, we check if the resource exists and user has access
        (owner or group chat member).
        """
        from app.services.task_member_service import task_member_service

        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == resource_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if task:
            # Check if user is owner or group chat member
            if task.user_id == user_id or task_member_service.is_member(
                db, resource_id, user_id
            ):
                return task

        return None  # Return None if not accessible to prevent unauthorized access

    def _get_resource_name(self, resource: TaskResource) -> str:
        """Get Task display name."""
        return resource.name or "Untitled Task"

    def _get_resource_owner_id(self, resource: TaskResource) -> int:
        """Get Task owner user ID."""
        return resource.user_id

    def _get_share_url_base(self) -> str:
        """Get base URL for Task share links."""
        # Use TASK_SHARE_BASE_URL from settings
        base_url = getattr(settings, "TASK_SHARE_BASE_URL", "http://localhost:3000")
        return f"{base_url}/shared/task"

    def _on_member_approved(
        self, db: Session, member: ResourceMember, resource: TaskResource
    ) -> Optional[int]:
        """
        Hook called when a Task member is approved.

        For Tasks, we copy the task and all its subtasks to the new user.
        This is the core Task-specific behavior.
        """
        try:
            # Import here to avoid circular imports
            from app.services.shared_task import shared_task_service

            # Get task details
            task_share_info = self._get_task_share_info(db, resource)
            if not task_share_info:
                logger.warning(
                    f"Could not get share info for task {resource.id}, " "skipping copy"
                )
                return None

            # For now, we delegate to the existing shared_task_service copy logic
            # This ensures backward compatibility during migration
            # TODO: Extract copy logic to this service after migration is complete

            logger.info(
                f"Task member approved: user={member.user_id}, "
                f"task={resource.id}, requires copy logic"
            )

            # Note: The actual copy logic is complex and involves:
            # 1. Creating a new task for the user
            # 2. Copying all subtasks and their contexts
            # 3. Handling workspace associations
            # For gradual migration, we keep this as a placeholder
            # The existing SharedTask table and service will handle actual copies
            # until full migration is complete

            return None  # Return None until copy logic is fully migrated

        except Exception as e:
            logger.error(f"Error in Task _on_member_approved: {e}")
            return None

    def _get_task_share_info(self, db: Session, task: TaskResource) -> Optional[dict]:
        """Extract share-relevant info from a task."""
        try:
            from app.schemas.kind import Task as TaskSchema
            from app.schemas.kind import Workspace

            task_crd = TaskSchema.model_validate(task.json)
            workspace_ref = task_crd.spec.workspaceRef

            info = {
                "task_id": task.id,
                "task_name": task.name,
                "user_id": task.user_id,
                "workspace_ref": workspace_ref,
            }

            # Get workspace details if available
            if workspace_ref:
                workspace = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.name == workspace_ref,
                        TaskResource.user_id == task.user_id,
                        TaskResource.kind == "Workspace",
                        TaskResource.is_active == True,
                    )
                    .first()
                )

                if workspace:
                    ws_crd = Workspace.model_validate(workspace.json)
                    repo = ws_crd.spec.repository
                    info["git_repo_id"] = repo.gitRepoId
                    info["git_repo"] = repo.gitRepo
                    info["git_domain"] = repo.gitDomain
                    info["branch_name"] = repo.branchName
                    info["git_url"] = repo.gitUrl

            return info

        except Exception as e:
            logger.warning(f"Error getting task share info: {e}")
            return None


# Singleton instance
task_share_service = TaskShareService()
