# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for synchronizing group membership changes to linked group chats.

When a group's membership changes (add/remove/update), this service synchronizes
those changes to all linked group chats that were created from that group.

This ensures that linked group chats always reflect the current group membership
without requiring complex JOIN queries at runtime.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import PermissionLevel, ResourceType
from app.models.task import TaskResource
from app.models.task_kb_binding import TaskKnowledgeBaseBinding
from app.schemas.namespace import GroupRole

logger = logging.getLogger(__name__)


class GroupMemberSyncService:
    """Service for synchronizing group membership to linked group chats."""

    def sync_member_added(
        self,
        db: Session,
        group_name: str,
        user_id: int,
        role: str,
    ) -> int:
        """Sync a new group member to all linked group chats.

        When a user is added to a group, add them to all linked group chats.

        Args:
            db: Database session
            group_name: Group/namespace name
            user_id: User ID being added
            role: Role assigned to the user

        Returns:
            Number of tasks updated
        """
        from app.models.namespace import Namespace

        # Get namespace ID
        namespace = (
            db.query(Namespace)
            .filter(Namespace.name == group_name, Namespace.is_active == True)
            .first()
        )

        if not namespace:
            logger.warning(f"[sync_member_added] Group '{group_name}' not found")
            return 0

        # Skip RestrictedObserver - they should not be added to group chats
        if role == GroupRole.RestrictedObserver.value:
            logger.info(
                f"[sync_member_added] Skipping RestrictedObserver user {user_id} for group '{group_name}'"
            )
            return 0

        # Find all linked group chats via task_knowledge_base_bindings
        # Use JOIN for efficient query on large tables (avoids large IN lists)
        linked_tasks = (
            db.query(TaskResource.id, TaskResource.user_id)
            .join(
                TaskKnowledgeBaseBinding,
                TaskResource.id == TaskKnowledgeBaseBinding.task_id,
            )
            .filter(
                TaskKnowledgeBaseBinding.linked_group_id == namespace.id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
                TaskResource.is_group_chat == True,
            )
            .distinct()
            .all()
        )

        if not linked_tasks:
            logger.debug(
                f"[sync_member_added] No linked group chats found for group '{group_name}'"
            )
            return 0

        # Map role to permission level
        role_to_permission = {
            GroupRole.OWNER.value: PermissionLevel.MANAGE.value,
            GroupRole.MAINTAINER.value: PermissionLevel.MANAGE.value,
            GroupRole.DEVELOPER.value: PermissionLevel.EDIT.value,
            GroupRole.REPORTER.value: PermissionLevel.VIEW.value,
        }
        permission_level = role_to_permission.get(role, PermissionLevel.VIEW.value)

        # Filter out task owners and prepare task list
        tasks_to_process = [
            (task_id, task_owner_id)
            for task_id, task_owner_id in linked_tasks
            if task_owner_id != user_id
        ]

        if not tasks_to_process:
            logger.debug(
                f"[sync_member_added] No tasks to process after filtering owners for group '{group_name}'"
            )
            return 0

        # Batch query existing members for all tasks (avoids N+1 queries)
        task_ids = [task_id for task_id, _ in tasks_to_process]
        existing_members = {
            member.resource_id: member
            for member in db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK.value,
                ResourceMember.resource_id.in_(task_ids),
                ResourceMember.user_id == user_id,
            )
            .all()
        }

        updated_count = 0
        for task_id, task_owner_id in tasks_to_process:
            existing = existing_members.get(task_id)

            if existing:
                if existing.status == MemberStatus.REJECTED:
                    # Reactivate rejected member
                    existing.status = MemberStatus.APPROVED.value
                    existing.role = role
                    existing.permission_level = permission_level
                    existing.updated_at = datetime.utcnow()
                    logger.info(
                        f"[sync_member_added] Reactivated member {user_id} in task {task_id}"
                    )
                    updated_count += 1
                elif existing.role != role:
                    # Update role if changed
                    existing.role = role
                    existing.permission_level = permission_level
                    existing.updated_at = datetime.utcnow()
                    logger.info(
                        f"[sync_member_added] Updated role for member {user_id} in task {task_id}"
                    )
                    updated_count += 1
            else:
                # Create new member
                task_member = ResourceMember(
                    resource_type=ResourceType.TASK.value,
                    resource_id=task_id,
                    user_id=user_id,
                    role=role,
                    permission_level=permission_level,
                    status=MemberStatus.APPROVED.value,
                    invited_by_user_id=task_owner_id,  # Task owner is the inviter
                    share_link_id=0,
                    reviewed_by_user_id=0,
                    reviewed_at=datetime(1970, 1, 1, 0, 0, 0),
                    requested_at=datetime.utcnow(),
                )
                db.add(task_member)
                logger.info(
                    f"[sync_member_added] Added member {user_id} to task {task_id}"
                )
                updated_count += 1

        db.commit()
        logger.info(
            f"[sync_member_added] Synced member {user_id} to {updated_count} tasks for group '{group_name}'"
        )
        return updated_count

    def sync_member_removed(
        self,
        db: Session,
        group_name: str,
        user_id: int,
    ) -> int:
        """Sync a group member removal to all linked group chats.

        When a user is removed from a group, remove them from all linked group chats.

        Args:
            db: Database session
            group_name: Group/namespace name
            user_id: User ID being removed

        Returns:
            Number of tasks updated
        """
        from app.models.namespace import Namespace

        # Get namespace ID
        namespace = (
            db.query(Namespace)
            .filter(Namespace.name == group_name, Namespace.is_active == True)
            .first()
        )

        if not namespace:
            logger.warning(f"[sync_member_removed] Group '{group_name}' not found")
            return 0

        # Find all linked group chats via task_knowledge_base_bindings
        # Use JOIN for efficient query on large tables (avoids large IN lists)
        linked_tasks = (
            db.query(TaskResource.id, TaskResource.user_id)
            .join(
                TaskKnowledgeBaseBinding,
                TaskResource.id == TaskKnowledgeBaseBinding.task_id,
            )
            .filter(
                TaskKnowledgeBaseBinding.linked_group_id == namespace.id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
                TaskResource.is_group_chat == True,
            )
            .distinct()
            .all()
        )

        if not linked_tasks:
            logger.debug(
                f"[sync_member_removed] No linked group chats found for group '{group_name}'"
            )
            return 0

        # Filter out task owners and prepare task list
        tasks_to_process = [
            task_id
            for task_id, task_owner_id in linked_tasks
            if task_owner_id != user_id
        ]

        if not tasks_to_process:
            logger.debug(
                f"[sync_member_removed] No tasks to process after filtering owners for group '{group_name}'"
            )
            return 0

        # Batch update: Use single UPDATE query instead of loop
        # This is much more efficient for large datasets
        result = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK.value,
                ResourceMember.resource_id.in_(tasks_to_process),
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .update(
                {
                    ResourceMember.status: MemberStatus.REJECTED.value,
                    ResourceMember.reviewed_by_user_id: 0,  # System removal
                    ResourceMember.reviewed_at: datetime.utcnow(),
                    ResourceMember.updated_at: datetime.utcnow(),
                },
                synchronize_session=False,
            )
        )

        updated_count = result
        if updated_count > 0:
            logger.info(
                f"[sync_member_removed] Removed member {user_id} from {updated_count} tasks for group '{group_name}'"
            )

        db.commit()
        return updated_count

    def sync_member_role_updated(
        self,
        db: Session,
        group_name: str,
        user_id: int,
        new_role: str,
    ) -> int:
        """Sync a group member role update to all linked group chats.

        When a user's role is changed in a group, update their role in all linked group chats.

        Args:
            db: Database session
            group_name: Group/namespace name
            user_id: User ID being updated
            new_role: New role assigned to the user

        Returns:
            Number of tasks updated
        """
        from app.models.namespace import Namespace

        # Get namespace ID
        namespace = (
            db.query(Namespace)
            .filter(Namespace.name == group_name, Namespace.is_active == True)
            .first()
        )

        if not namespace:
            logger.warning(f"[sync_member_role_updated] Group '{group_name}' not found")
            return 0

        # Find all linked group chats via task_knowledge_base_bindings
        # Use JOIN for efficient query on large tables (avoids large IN lists)
        linked_tasks = (
            db.query(TaskResource.id, TaskResource.user_id)
            .join(
                TaskKnowledgeBaseBinding,
                TaskResource.id == TaskKnowledgeBaseBinding.task_id,
            )
            .filter(
                TaskKnowledgeBaseBinding.linked_group_id == namespace.id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
                TaskResource.is_group_chat == True,
            )
            .distinct()
            .all()
        )

        if not linked_tasks:
            logger.debug(
                f"[sync_member_role_updated] No linked group chats found for group '{group_name}'"
            )
            return 0

        # Map role to permission level
        role_to_permission = {
            GroupRole.OWNER.value: PermissionLevel.MANAGE.value,
            GroupRole.MAINTAINER.value: PermissionLevel.MANAGE.value,
            GroupRole.DEVELOPER.value: PermissionLevel.EDIT.value,
            GroupRole.REPORTER.value: PermissionLevel.VIEW.value,
        }
        permission_level = role_to_permission.get(new_role, PermissionLevel.VIEW.value)

        # Filter out task owners and prepare task list
        tasks_to_process = [
            task_id
            for task_id, task_owner_id in linked_tasks
            if task_owner_id != user_id
        ]

        if not tasks_to_process:
            logger.debug(
                f"[sync_member_role_updated] No tasks to process after filtering owners for group '{group_name}'"
            )
            return 0

        # Handle RestrictedObserver: batch remove from all tasks
        if new_role == GroupRole.RestrictedObserver.value:
            result = (
                db.query(ResourceMember)
                .filter(
                    ResourceMember.resource_type == ResourceType.TASK.value,
                    ResourceMember.resource_id.in_(tasks_to_process),
                    ResourceMember.user_id == user_id,
                )
                .update(
                    {
                        ResourceMember.status: MemberStatus.REJECTED.value,
                        ResourceMember.reviewed_at: datetime.utcnow(),
                        ResourceMember.updated_at: datetime.utcnow(),
                    },
                    synchronize_session=False,
                )
            )
            updated_count = result
            if updated_count > 0:
                logger.info(
                    f"[sync_member_role_updated] Removed RestrictedObserver {user_id} from {updated_count} tasks"
                )
            db.commit()
            return updated_count

        # Batch update role for all other cases
        result = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK.value,
                ResourceMember.resource_id.in_(tasks_to_process),
                ResourceMember.user_id == user_id,
            )
            .update(
                {
                    ResourceMember.role: new_role,
                    ResourceMember.permission_level: permission_level,
                    ResourceMember.status: MemberStatus.APPROVED.value,
                    ResourceMember.updated_at: datetime.utcnow(),
                },
                synchronize_session=False,
            )
        )

        updated_count = result
        if updated_count > 0:
            logger.info(
                f"[sync_member_role_updated] Updated role for member {user_id} to {new_role} in {updated_count} tasks"
            )

        db.commit()
        return updated_count


group_member_sync_service = GroupMemberSyncService()
