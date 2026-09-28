# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.interfaces import TaskRuntimeState


class SqlAlchemyTaskAccessStore:
    """SQLAlchemy implementation for task ownership and membership checks."""

    def get_task(self, db: Session, *, task_id: int) -> Optional[TaskResource]:
        return self._get_accessible_task(db, task_id=task_id)

    def get_task_owner_id(self, db: Session, *, task_id: int) -> Optional[int]:
        task = self._get_accessible_task(db, task_id=task_id)
        if task is None:
            return None
        return int(task.user_id)

    def is_task_owner(self, db: Session, *, task_id: int, user_id: int) -> bool:
        task = self._get_accessible_task(db, task_id=task_id)
        return task is not None and task.user_id == user_id

    def is_member(self, db: Session, *, task_id: int, user_id: int) -> bool:
        task = self._get_accessible_task(db, task_id=task_id)
        if task is None:
            return False
        if task.user_id == user_id:
            return True

        return (
            self._approved_membership_query(
                db, task_id=task_id, user_id=user_id
            ).first()
            is not None
        )

    def _approved_membership_query(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Query:
        return db.query(ResourceMember.id).filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == task_id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED,
            ResourceMember.copied_resource_id == 0,
        )

    def get_runtime_state(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[TaskRuntimeState]:
        """Project only checkpoint fields, using the same owner/member policy."""
        task_status = TaskResource.json["status"]["status"].as_string()
        status_updated_at = TaskResource.json["status"]["updatedAt"].as_string()
        membership = self._approved_membership_query(
            db, task_id=task_id, user_id=user_id
        ).exists()
        row = (
            db.query(task_status, status_updated_at, TaskResource.updated_at)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.in_(TaskResource.is_active_query()),
                task_status != "DELETE",
                or_(TaskResource.user_id == user_id, membership),
            )
            .first()
        )
        if row is None:
            return None
        return TaskRuntimeState(status=row[0], updated_at=row[1] or row[2])

    def is_group_chat(self, db: Session, *, task_id: int) -> bool:
        task = self._get_accessible_task(db, task_id=task_id)
        if task is None:
            return False
        if task.is_group_chat:
            return True
        task_json = task.json if isinstance(task.json, dict) else {}
        return bool((task_json.get("spec") or {}).get("is_group_chat", False))

    def list_member_task_ids(self, db: Session, *, user_id: int) -> set[int]:
        rows = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
                ResourceMember.copied_resource_id == 0,
            )
            .all()
        )
        return {row[0] for row in rows}

    def _get_accessible_task(
        self, db: Session, *, task_id: int
    ) -> Optional[TaskResource]:
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.in_(TaskResource.is_active_query()),
            )
            .first()
        )
