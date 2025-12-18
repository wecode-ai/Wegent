# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for task member (group chat) management.
"""

import logging
from datetime import datetime
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.task_member import MemberStatus, TaskMember
from app.models.user import User
from app.schemas.task_member import TaskMemberListResponse, TaskMemberResponse

logger = logging.getLogger(__name__)


class TaskMemberService:
    """Service for managing group chat members."""

    def get_task(self, db: Session, task_id: int) -> Optional[Kind]:
        """Get a task by ID"""
        return (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.kind == "Task",
                Kind.is_active == True,
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
        # Task owner is always considered a member
        if self.is_task_owner(db, task_id, user_id):
            return True

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.user_id == user_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )
        return member is not None

    def is_group_chat(self, db: Session, task_id: int) -> bool:
        """Check if a task is configured as a group chat"""
        task = self.get_task(db, task_id)
        if not task:
            return False

        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        return spec.get("is_group_chat", False)

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
        member_count = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .count()
        )
        # Add 1 for the task owner
        return member_count + 1

    def get_members(self, db: Session, task_id: int) -> TaskMemberListResponse:
        """Get all active members of a task"""
        task = self.get_task(db, task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

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
            status=MemberStatus.ACTIVE,
            joined_at=task.created_at,
            is_owner=True,
        )
        members.append(owner_member)

        # Get other members
        task_members = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .all()
        )

        for tm in task_members:
            user = self.get_user(db, tm.user_id)
            inviter = self.get_user(db, tm.invited_by)

            if user:
                member = TaskMemberResponse(
                    id=tm.id,
                    task_id=task_id,
                    user_id=tm.user_id,
                    username=user.user_name,
                    avatar=None,
                    invited_by=tm.invited_by,
                    inviter_name=inviter.user_name if inviter else "Unknown",
                    status=tm.status,
                    joined_at=tm.joined_at,
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
    ) -> TaskMember:
        """Add a user as a member to a task"""
        # Check if user already exists (even if removed)
        existing = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.user_id == user_id,
            )
            .first()
        )

        if existing:
            if existing.status == MemberStatus.ACTIVE:
                raise HTTPException(status_code=400, detail="User is already a member")
            # Reactivate removed member
            existing.status = MemberStatus.ACTIVE
            existing.invited_by = invited_by
            existing.joined_at = datetime.utcnow()
            existing.removed_at = datetime(
                1970, 1, 1
            )  # Reset to default epoch time for not removed
            existing.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(existing)
            return existing

        # Create new member
        new_member = TaskMember(
            task_id=task_id,
            user_id=user_id,
            invited_by=invited_by,
            status=MemberStatus.ACTIVE,
        )
        db.add(new_member)
        db.commit()
        db.refresh(new_member)
        return new_member

    def remove_member(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        removed_by: int,
    ) -> bool:
        """Remove a member from a task (soft delete)"""
        # Cannot remove the task owner
        if self.is_task_owner(db, task_id, user_id):
            raise HTTPException(status_code=400, detail="Cannot remove the task owner")

        member = (
            db.query(TaskMember)
            .filter(
                TaskMember.task_id == task_id,
                TaskMember.user_id == user_id,
                TaskMember.status == MemberStatus.ACTIVE,
            )
            .first()
        )

        if not member:
            raise HTTPException(status_code=404, detail="Member not found")

        member.status = MemberStatus.REMOVED
        member.removed_at = datetime.utcnow()
        member.updated_at = datetime.utcnow()
        db.commit()

        return True

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


task_member_service = TaskMemberService()
