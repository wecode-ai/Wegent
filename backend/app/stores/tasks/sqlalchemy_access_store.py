# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource


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

        member = (
            db.query(ResourceMember.id)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
                ResourceMember.copied_resource_id == 0,
            )
            .first()
        )
        return member is not None

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
