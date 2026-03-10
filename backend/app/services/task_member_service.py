# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for task member (group chat) management.

Uses the unified ResourceMember model instead of the legacy TaskMember table.
Supports linked group chats where members are derived from group membership.
"""

import logging
from datetime import datetime
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import EPOCH_TIME, MemberStatus, ResourceMember
from app.models.share_link import PermissionLevel, ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.task_member import MemberStatus as SchemaMemberStatus
from app.schemas.task_member import (
    TaskMemberListResponse,
    TaskMemberResponse,
)

logger = logging.getLogger(__name__)


class TaskMemberService:
    """Service for managing group chat members using ResourceMember."""

    def get_task(self, db: Session, task_id: int) -> Optional[TaskResource]:
        """Get a task by ID"""
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

    def get_user(self, db: Session, user_id: int) -> Optional[User]:
        """Get a user by ID"""
        return db.query(User).filter(User.id == user_id, User.is_active == True).first()

    def get_task_owner_id(self, db: Session, task_id: int) -> Optional[int]:
        """Get the owner (creator) user_id of a task"""
        task = self.get_task(db, task_id)
        if task:
            return task.user_id
        return None

    def is_task_owner(self, db: Session, task_id: int, user_id: int) -> bool:
        """Check if a user is the owner of a task"""
        task = self.get_task(db, task_id)
        return task is not None and task.user_id == user_id

    def is_member(self, db: Session, task_id: int, user_id: int) -> bool:
        """Check if a user is an active member of a task"""
        logger.info(
            f"[is_member] Checking membership: task_id={task_id}, user_id={user_id}"
        )

        # Task owner is always considered a member
        is_owner = self.is_task_owner(db, task_id, user_id)
        logger.info(
            f"[is_member] is_task_owner: task_id={task_id}, user_id={user_id}, result={is_owner}"
        )
        if is_owner:
            return True

        # For linked group chats, check membership via the linked group
        is_linked_member = self.is_member_via_linked_group(db, task_id, user_id)
        logger.info(
            f"[is_member] is_member_via_linked_group: task_id={task_id}, user_id={user_id}, result={is_linked_member}"
        )
        if is_linked_member:
            return True

        # Check ResourceMember for approved status
        # Exclude share records (copied_resource_id > 0), only consider actual group chat members
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED,
                ResourceMember.copied_resource_id == 0,
            )
            .first()
        )
        result = member is not None
        logger.info(
            f"[is_member] ResourceMember check: task_id={task_id}, user_id={user_id}, result={result}"
        )
        return result

    def is_group_chat(self, db: Session, task_id: int) -> bool:
        """Check if a task is configured as a group chat"""
        logger.info(f"[is_group_chat] Checking task_id={task_id}")
        task = self.get_task(db, task_id)
        if not task:
            logger.warning(f"[is_group_chat] Task {task_id} not found")
            return False

        task_json = task.json if isinstance(task.json, dict) else {}
        logger.info(
            f"[is_group_chat] task_id={task_id}, task_json type={type(task.json)}, is_dict={isinstance(task.json, dict)}"
        )
        spec = task_json.get("spec", {})
        is_group_chat = spec.get("is_group_chat", False)
        logger.info(
            f"[is_group_chat] task_id={task_id}, is_group_chat={is_group_chat}, spec={spec}"
        )
        return is_group_chat

    def convert_to_group_chat(self, db: Session, task_id: int) -> bool:
        """Convert an existing task to a group chat"""
        task = self.get_task(db, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Get current task JSON
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})

        # Check if already a group chat
        if spec.get("is_group_chat", False):
            return False  # Already a group chat

        # Set is_group_chat flag
        spec["is_group_chat"] = True
        task_json["spec"] = spec

        # IMPORTANT: Mark the json field as modified so SQLAlchemy detects the change
        task.json = task_json
        flag_modified(task, "json")

        task.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(task)

        logger.info(f"Task {task_id} converted to group chat")
        return True

    def get_member_count(self, db: Session, task_id: int) -> int:
        """Get the number of active members in a task (including owner)"""
        # For linked group chats, get member count from the linked group
        if self.is_linked_group_chat(db, task_id):
            return self.get_linked_group_member_count(db, task_id)

        # Exclude share records (copied_resource_id > 0), only count actual group chat members
        member_count = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.status == MemberStatus.APPROVED,
                ResourceMember.copied_resource_id == 0,
            )
            .count()
        )
        # Add 1 for the task owner
        return member_count + 1

    def get_members(self, db: Session, task_id: int) -> TaskMemberListResponse:
        """Get all active members of a task"""
        logger.info(f"[get_members] Getting members for task_id={task_id}")
        task = self.get_task(db, task_id)
        if not task:
            logger.warning(f"[get_members] Task {task_id} not found")
            raise HTTPException(status_code=404, detail="Task not found")

        # For linked group chats, get members from the linked group
        is_linked = self.is_linked_group_chat(db, task_id)
        logger.info(
            f"[get_members] task_id={task_id}, is_linked_group_chat={is_linked}"
        )
        if is_linked:
            logger.info(
                f"[get_members] Delegating to get_linked_group_members for task_id={task_id}"
            )
            return self.get_linked_group_members(db, task_id)

        task_owner_id = task.user_id

        # Get task owner info
        owner = self.get_user(db, task_owner_id)
        if not owner:
            raise HTTPException(status_code=404, detail="Task owner not found")

        # Build member list, starting with owner
        members = []

        # Add owner as first member
        owner_member = TaskMemberResponse(
            id=0,  # Special ID for owner
            task_id=task_id,
            user_id=task_owner_id,
            username=owner.user_name,
            avatar=None,  # Add avatar field if exists in User model
            invited_by=task_owner_id,
            inviter_name=owner.user_name,
            status=SchemaMemberStatus.ACTIVE,
            joined_at=task.created_at,
            is_owner=True,
        )
        members.append(owner_member)

        # Get other members from ResourceMember
        # Exclude share records (copied_resource_id > 0), only get actual group chat members
        task_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.status == MemberStatus.APPROVED,
                ResourceMember.copied_resource_id == 0,
            )
            .all()
        )

        for tm in task_members:
            user = self.get_user(db, tm.user_id)
            inviter = (
                self.get_user(db, tm.invited_by_user_id)
                if tm.invited_by_user_id > 0
                else None
            )

            if user:
                member = TaskMemberResponse(
                    id=tm.id,
                    task_id=task_id,
                    user_id=tm.user_id,
                    username=user.user_name,
                    avatar=None,
                    invited_by=tm.invited_by_user_id,
                    inviter_name=inviter.user_name if inviter else "Unknown",
                    status=SchemaMemberStatus.ACTIVE,
                    joined_at=tm.requested_at,
                    is_owner=False,
                )
                members.append(member)

        return TaskMemberListResponse(
            members=members,
            total=len(members),
            task_owner_id=task_owner_id,
        )

    def add_member(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        invited_by: int,
    ) -> ResourceMember:
        """Add a user as a member to a task"""
        logger.info(
            f"[add_member] Adding member: task_id={task_id}, user_id={user_id}, invited_by={invited_by}"
        )

        # Linked group chats do not allow member modification
        if self.is_linked_group_chat(db, task_id):
            linked_group = self.get_linked_group(db, task_id)
            raise HTTPException(
                status_code=400,
                detail=f"Cannot add members to a linked group chat. Members are managed through the group '{linked_group}'.",
            )

        # Check if user already exists (even if rejected)
        existing = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.user_id == user_id,
            )
            .first()
        )

        if existing:
            logger.info(
                f"[add_member] Existing member found: id={existing.id}, status={existing.status}"
            )
            if existing.status == MemberStatus.APPROVED:
                logger.warning(
                    f"[add_member] User {user_id} is already a member of task {task_id}"
                )
                raise HTTPException(status_code=400, detail="User is already a member")
            # Reactivate rejected/pending member
            logger.info(
                f"[add_member] Reactivating member: id={existing.id}, old_status={existing.status}"
            )
            existing.status = MemberStatus.APPROVED
            existing.invited_by_user_id = invited_by
            existing.requested_at = datetime.utcnow()
            existing.updated_at = datetime.utcnow()
            existing.permission_level = (
                PermissionLevel.MANAGE
            )  # Group chat members get manage permission
            # Clear stale review metadata from previous rejection
            existing.reviewed_by_user_id = 0
            existing.reviewed_at = EPOCH_TIME
            db.commit()
            db.refresh(existing)
            logger.info(
                f"[add_member] Member reactivated successfully: id={existing.id}"
            )
            return existing

        # Create new member
        logger.info(
            f"[add_member] Creating new member for task {task_id}, user {user_id}"
        )
        new_member = ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=task_id,
            user_id=user_id,
            permission_level=PermissionLevel.MANAGE,  # Group chat members get manage permission
            status=MemberStatus.APPROVED,
            invited_by_user_id=invited_by,
            share_link_id=0,
            reviewed_by_user_id=0,
            copied_resource_id=0,
            requested_at=datetime.utcnow(),
        )
        db.add(new_member)
        db.commit()
        db.refresh(new_member)
        logger.info(f"[add_member] New member created successfully: id={new_member.id}")
        return new_member

    def remove_member(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        removed_by: int,
    ) -> bool:
        """Remove a member from a task (soft delete by setting status to rejected)"""
        # Linked group chats do not allow member modification
        if self.is_linked_group_chat(db, task_id):
            linked_group = self.get_linked_group(db, task_id)
            raise HTTPException(
                status_code=400,
                detail=f"Cannot remove members from a linked group chat. Members are managed through the group '{linked_group}'.",
            )

        # Cannot remove the task owner
        if self.is_task_owner(db, task_id, user_id):
            raise HTTPException(status_code=400, detail="Cannot remove the task owner")

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Member not found")

        member.status = MemberStatus.REJECTED
        member.reviewed_by_user_id = removed_by
        member.reviewed_at = datetime.utcnow()
        member.updated_at = datetime.utcnow()
        db.commit()

        return True

    def get_team_id(self, db: Session, task_id: int) -> Optional[int]:
        """Get the team ID associated with a task"""
        task = self.get_task(db, task_id)
        if not task:
            return None

        try:
            task_json = task.json if isinstance(task.json, dict) else {}
            spec = task_json.get("spec", {})
            team_ref = spec.get("teamRef", {})
            team_name = team_ref.get("name")
            team_namespace = team_ref.get("namespace", "default")

            if team_name:
                # Get the team Kind to get its ID
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.name == team_name,
                        Kind.namespace == team_namespace,
                        Kind.kind == "Team",
                        Kind.is_active == True,
                    )
                    .first()
                )
                if team:
                    return team.id
        except Exception as e:
            logger.warning(f"Failed to get team ID: {e}")

        return None

    def get_team_name(self, db: Session, task_id: int) -> Optional[str]:
        """Get the team name associated with a task"""
        task = self.get_task(db, task_id)
        if not task:
            return None

        try:
            task_json = task.json if isinstance(task.json, dict) else {}
            spec = task_json.get("spec", {})
            team_ref = spec.get("teamRef", {})
            team_name = team_ref.get("name")
            team_namespace = team_ref.get("namespace", "default")

            if team_name:
                # Get the team Kind to get its display name
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.name == team_name,
                        Kind.namespace == team_namespace,
                        Kind.kind == "Team",
                        Kind.is_active == True,
                    )
                    .first()
                )
                if team:
                    team_json = team.json if isinstance(team.json, dict) else {}
                    team_spec = team_json.get("spec", {})
                    return team_spec.get("displayName", team_name)
                return team_name
        except Exception as e:
            logger.warning(f"Failed to get team name: {e}")

        return None

    # =========================================================================
    # Linked Group Chat Methods
    # =========================================================================

    def get_linked_group(self, db: Session, task_id: int) -> Optional[str]:
        """Get the linked group name for a task.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            Linked group name if set, None otherwise
        """
        task = self.get_task(db, task_id)
        if not task:
            logger.info(f"[get_linked_group] Task {task_id} not found")
            return None

        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        linked_group = spec.get("linked_group")
        logger.info(
            f"[get_linked_group] task_id={task_id}, linked_group={linked_group}, spec_keys={list(spec.keys())}"
        )
        return linked_group

    def is_linked_group_chat(self, db: Session, task_id: int) -> bool:
        """Check if a task is a linked group chat.

        A linked group chat has its members derived from a group,
        and member management is disabled in the UI.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            True if the task is a linked group chat
        """
        return self.get_linked_group(db, task_id) is not None

    def is_member_via_linked_group(
        self, db: Session, task_id: int, user_id: int
    ) -> bool:
        """Check if a user is a member via linked group.

        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID

        Returns:
            True if user is a member of the linked group
        """
        linked_group = self.get_linked_group(db, task_id)
        logger.info(
            f"[is_member_via_linked_group] task_id={task_id}, user_id={user_id}, linked_group={linked_group}"
        )
        if not linked_group:
            return False

        from app.services.group_permission import get_effective_role_in_group

        role = get_effective_role_in_group(db, user_id, linked_group)
        result = role is not None
        logger.info(
            f"[is_member_via_linked_group] task_id={task_id}, user_id={user_id}, role={role}, result={result}"
        )
        return result

    def get_linked_group_members(
        self, db: Session, task_id: int
    ) -> TaskMemberListResponse:
        """Get members from the linked group.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            TaskMemberListResponse with members from the linked group

        Raises:
            HTTPException: If task not found or not a linked group chat
        """
        logger.info(f"[get_linked_group_members] Getting members for task_id={task_id}")
        task = self.get_task(db, task_id)
        if not task:
            logger.warning(f"[get_linked_group_members] Task {task_id} not found")
            raise HTTPException(status_code=404, detail="Task not found")

        linked_group = self.get_linked_group(db, task_id)
        logger.info(
            f"[get_linked_group_members] task_id={task_id}, linked_group={linked_group}"
        )
        if not linked_group:
            raise HTTPException(
                status_code=400, detail="Task is not a linked group chat"
            )

        # Get the namespace (group)
        namespace = (
            db.query(Namespace)
            .filter(Namespace.name == linked_group, Namespace.is_active == True)
            .first()
        )
        logger.info(
            f"[get_linked_group_members] linked_group={linked_group}, namespace_found={namespace is not None}, namespace_id={namespace.id if namespace else None}"
        )

        if not namespace:
            raise HTTPException(status_code=404, detail="Linked group not found")

        # Get all approved members from the group
        group_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == "Namespace",
                ResourceMember.resource_id == namespace.id,
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .all()
        )
        logger.info(
            f"[get_linked_group_members] namespace_id={namespace.id}, group_members_count={len(group_members)}"
        )

        members = []
        task_owner_id = task.user_id

        for gm in group_members:
            user = self.get_user(db, gm.user_id)
            if not user:
                logger.warning(
                    f"[get_linked_group_members] User {gm.user_id} not found, skipping"
                )
                continue

            # Determine if this user is the task owner
            is_owner = gm.user_id == task_owner_id

            member = TaskMemberResponse(
                id=gm.id,
                task_id=task_id,
                user_id=gm.user_id,
                username=user.user_name,
                avatar=None,
                invited_by=gm.invited_by_user_id or 0,
                inviter_name="Group",  # Members come from group
                status=SchemaMemberStatus.ACTIVE,
                joined_at=gm.created_at,
                is_owner=is_owner,
                role=gm.role,  # Include group role
            )
            members.append(member)
            logger.debug(
                f"[get_linked_group_members] Added member: user_id={gm.user_id}, username={user.user_name}, role={gm.role}"
            )

        # Sort: owner first, then by username
        members.sort(key=lambda m: (not m.is_owner, m.username.lower()))

        logger.info(
            f"[get_linked_group_members] Returning {len(members)} members for task_id={task_id}"
        )
        return TaskMemberListResponse(
            members=members,
            total=len(members),
            task_owner_id=task_owner_id,
            linked_group=linked_group,
        )

    def get_linked_group_member_count(self, db: Session, task_id: int) -> int:
        """Get the number of members in the linked group.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            Number of members in the linked group, or 0 if not a linked group chat
        """
        linked_group = self.get_linked_group(db, task_id)
        if not linked_group:
            return 0

        # Get the namespace (group)
        namespace = (
            db.query(Namespace)
            .filter(Namespace.name == linked_group, Namespace.is_active == True)
            .first()
        )

        if not namespace:
            return 0

        # Count approved members in the group
        return (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == "Namespace",
                ResourceMember.resource_id == namespace.id,
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .count()
        )


task_member_service = TaskMemberService()
