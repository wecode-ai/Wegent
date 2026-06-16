# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json as json_lib
import logging
import uuid
from datetime import datetime
from time import perf_counter
from typing import Any, Callable, Literal, Optional, Sequence

from sqlalchemy import func, text, tuple_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.interfaces import WorkspaceRefLookup

logger = logging.getLogger(__name__)

_ACCESSIBLE_COUNT_SQL = text(
    """
    SELECT COUNT(DISTINCT k.id)
    FROM tasks k
    LEFT JOIN resource_members tm ON k.id = tm.resource_id
        AND tm.resource_type = 'Task'
        AND tm.entity_type = 'user'
        AND tm.entity_id = :entity_id
        AND tm.status = 'approved'
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND (k.user_id = :user_id OR tm.id IS NOT NULL)
"""
)

_ACCESSIBLE_IDS_SQL = text(
    """
    SELECT DISTINCT k.id, k.created_at
    FROM tasks k
    LEFT JOIN resource_members tm ON k.id = tm.resource_id
        AND tm.resource_type = 'Task'
        AND tm.entity_type = 'user'
        AND tm.entity_id = :entity_id
        AND tm.status = 'approved'
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND (k.user_id = :user_id OR tm.id IS NOT NULL)
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_OWNED_COUNT_SQL = text(
    """
    SELECT COUNT(*)
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
"""
)

_OWNED_IDS_SQL = text(
    """
    SELECT k.id, k.created_at
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_PERSONAL_COUNT_SQL = text(
    """
    SELECT COUNT(*)
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
"""
)

_PERSONAL_COUNT_BY_ORIGIN_SQL = text(
    """
    SELECT COUNT(*)
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    AND k.client_origin = :client_origin
"""
)

_PERSONAL_STANDALONE_COUNT_SQL = text(
    """
    SELECT COUNT(*)
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    AND k.project_id = 0
"""
)

_PERSONAL_STANDALONE_COUNT_BY_ORIGIN_SQL = text(
    """
    SELECT COUNT(*)
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    AND k.client_origin = :client_origin
    AND k.project_id = 0
"""
)

_PERSONAL_IDS_SQL = text(
    """
    SELECT k.id, k.created_at
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_PERSONAL_IDS_BY_ORIGIN_SQL = text(
    """
    SELECT k.id, k.created_at
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    AND k.client_origin = :client_origin
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_PERSONAL_STANDALONE_IDS_SQL = text(
    """
    SELECT k.id, k.created_at
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    AND k.project_id = 0
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_PERSONAL_STANDALONE_IDS_BY_ORIGIN_SQL = text(
    """
    SELECT k.id, k.created_at
    FROM tasks k
    WHERE k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
    AND k.user_id = :user_id
    AND k.is_group_chat = 0
    AND k.client_origin = :client_origin
    AND k.project_id = 0
    ORDER BY k.created_at DESC
    LIMIT :limit OFFSET :skip
"""
)

_OWNED_GROUP_CHAT_SQL = text(
    """
    SELECT id
    FROM tasks
    WHERE kind = 'Task'
    AND is_active = :is_active
    AND namespace != 'system'
    AND user_id = :user_id
    AND is_group_chat = 1
"""
)

_MEMBER_TASK_IDS_SQL = text(
    """
    SELECT k.id
    FROM resource_members tm
    JOIN tasks k ON k.id = tm.resource_id
    WHERE tm.resource_type = 'Task'
    AND tm.entity_type = 'user'
    AND tm.entity_id = :entity_id
    AND tm.status = 'approved'
    AND tm.copied_resource_id = 0
    AND k.kind = 'Task'
    AND k.is_active = :is_active
    AND k.namespace != 'system'
"""
)


def _timed_scalar(
    db: Session, sql: object, params: dict[str, object], query_name: str
) -> int:
    started_at = perf_counter()
    value = db.execute(sql, params).scalar()
    elapsed_ms = (perf_counter() - started_at) * 1000
    logger.debug("[task_query:%s] scalar elapsed_ms=%.2f", query_name, elapsed_ms)
    return int(value or 0)


def _timed_rows(
    db: Session, sql: object, params: dict[str, object], query_name: str
) -> list:
    started_at = perf_counter()
    rows = db.execute(sql, params).fetchall()
    elapsed_ms = (perf_counter() - started_at) * 1000
    logger.debug(
        "[task_query:%s] rows=%s elapsed_ms=%.2f",
        query_name,
        len(rows),
        elapsed_ms,
    )
    return rows


class SqlAlchemyTaskStore:
    """SQLAlchemy implementation for Task and Workspace resource access."""

    def _filter_owner_user_id(
        self,
        query,
        *,
        owner_user_id: Optional[int],
    ):
        if owner_user_id is None:
            return query
        return query.filter(TaskResource.user_id == owner_user_id)

    def create_placeholder_task_id(self, db: Session, *, user_id: int) -> int:
        placeholder_name = f"temp-placeholder-{uuid.uuid4().hex}"
        placeholder_json = {
            "kind": "Placeholder",
            "metadata": {"name": placeholder_name, "namespace": "default"},
            "spec": {},
            "status": {"state": "Reserved"},
        }
        now = datetime.now()
        result = db.execute(
            text(
                """
                INSERT INTO tasks
                    (user_id, kind, name, namespace, json, is_active, created_at,
                     updated_at, project_id, is_group_chat)
                VALUES
                    (:user_id, 'Placeholder', :name, 'default', :json, false,
                     :created_at, :updated_at, 0, false)
                """
            ),
            {
                "user_id": user_id,
                "name": placeholder_name,
                "json": json_lib.dumps(placeholder_json),
                "created_at": now,
                "updated_at": now,
            },
        )
        allocated_id = result.lastrowid
        if not allocated_id:
            raise RuntimeError("Failed to allocate task ID")
        db.commit()
        return int(allocated_id)

    def is_valid_task_id(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> bool:
        query = db.query(TaskResource.id).filter(TaskResource.id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first() is not None

    def create_pending_task_shell(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        is_group_chat: bool = False,
        project_id: int = 0,
    ) -> TaskResource:
        task = TaskResource(
            user_id=user_id,
            kind="Task",
            name=f"task-pending-{uuid.uuid4().hex}",
            namespace="default",
            json={"kind": "Task"},
            is_active=TaskResource.STATE_ACTIVE,
            is_group_chat=is_group_chat,
            client_origin=client_origin,
            project_id=project_id,
        )
        db.add(task)
        db.flush()
        return task

    def create_workspace(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
        payload: dict[str, Any],
        client_origin: str,
    ) -> TaskResource:
        workspace = TaskResource(
            user_id=user_id,
            kind="Workspace",
            name=name,
            namespace=namespace,
            json=payload,
            is_active=TaskResource.STATE_ACTIVE,
            client_origin=client_origin,
        )
        db.add(workspace)
        return workspace

    def create_pending_task_shell_with_workspace(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        workspace_factory: Callable[[int], tuple[str, str, dict[str, Any]]],
        is_group_chat: bool = False,
        project_id: int = 0,
    ) -> tuple[TaskResource, TaskResource]:
        task = self.create_pending_task_shell(
            db,
            user_id=user_id,
            client_origin=client_origin,
            is_group_chat=is_group_chat,
            project_id=project_id,
        )
        workspace_name, workspace_namespace, workspace_payload = workspace_factory(
            task.id
        )
        workspace = self.create_workspace(
            db,
            user_id=user_id,
            name=workspace_name,
            namespace=workspace_namespace,
            payload=workspace_payload,
            client_origin=client_origin,
        )
        return task, workspace

    def create_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        name: str,
        namespace: str,
        payload: dict[str, Any],
        client_origin: str,
        project_id: int = 0,
        is_group_chat: bool = False,
    ) -> TaskResource:
        task = (
            db.query(TaskResource)
            .filter(TaskResource.id == task_id, TaskResource.kind == "Placeholder")
            .first()
        )
        if task is None:
            task = TaskResource(id=task_id)
            db.add(task)

        task.user_id = user_id
        task.kind = "Task"
        task.name = name
        task.namespace = namespace
        task.json = payload
        task.is_active = TaskResource.STATE_ACTIVE
        task.project_id = project_id
        task.client_origin = client_origin
        task.is_group_chat = is_group_chat
        task.updated_at = datetime.now()
        self._flag_json_modified(task)
        return task

    def create_task_resource(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
        payload: dict[str, Any],
        client_origin: str,
        state: int = TaskResource.STATE_ACTIVE,
        project_id: int = 0,
        is_group_chat: bool = False,
    ) -> TaskResource:
        task = TaskResource(
            user_id=user_id,
            kind="Task",
            name=name,
            namespace=namespace,
            json=payload,
            is_active=state,
            client_origin=client_origin,
            project_id=project_id,
            is_group_chat=is_group_chat,
        )
        db.add(task)
        return task

    def get_by_id(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(TaskResource.id == task_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.in_(TaskResource.is_active_query()),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_non_deleted_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active != TaskResource.STATE_DELETED,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_regular_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.namespace != "system",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_owned_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_owned_task_by_name(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> Optional[TaskResource]:
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Task",
                TaskResource.namespace == namespace,
                TaskResource.name == name,
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
            )
            .first()
        )

    def get_active_non_deleted_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.in_(TaskResource.is_active_query()),
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_active_or_archived_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.in_(
                [TaskResource.STATE_ACTIVE, TaskResource.STATE_ARCHIVED]
            ),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_owned_task_by_state(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        state: int,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == state,
        )
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_task_by_states(
        self,
        db: Session,
        *,
        task_id: int,
        states: Sequence[int],
        kind: str = "Task",
        user_id: Optional[int] = None,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        if not states:
            return None
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.kind == kind,
            TaskResource.is_active.in_(states),
        )
        if user_id is not None:
            query = query.filter(TaskResource.user_id == user_id)
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def get_task_by_workspace_ref(
        self,
        db: Session,
        *,
        user_id: int,
        workspace_name: str,
        workspace_namespace: str,
    ) -> Optional[TaskResource]:
        tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.in_(TaskResource.is_active_query()),
            )
            .all()
        )
        for task in tasks:
            workspace_ref = (task.json or {}).get("spec", {}).get("workspaceRef", {})
            if (
                workspace_ref.get("name") == workspace_name
                and workspace_ref.get("namespace") == workspace_namespace
            ):
                return task
        return None

    def get_workspace_by_ref(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> Optional[TaskResource]:
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Workspace",
                TaskResource.name == name,
                TaskResource.namespace == namespace,
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
            )
            .first()
        )

    def get_active_workspace_by_id(
        self,
        db: Session,
        *,
        workspace_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == workspace_id,
            TaskResource.kind == "Workspace",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.first()

    def get_owned_active_workspace_by_id(
        self, db: Session, *, workspace_id: int, user_id: int
    ) -> Optional[TaskResource]:
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.id == workspace_id,
                TaskResource.user_id == user_id,
                TaskResource.kind == "Workspace",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
            )
            .first()
        )

    def list_active_workspaces_by_ids(
        self,
        db: Session,
        *,
        workspace_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
    ) -> list[TaskResource]:
        if not workspace_ids:
            return []
        query = db.query(TaskResource).filter(
            TaskResource.id.in_(workspace_ids),
            TaskResource.kind == "Workspace",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.all()

    def list_active_workspaces_by_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Workspace",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
            )
            .all()
        )

    def list_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
    ) -> list[TaskResource]:
        if not task_ids:
            return []
        query = db.query(TaskResource).filter(TaskResource.id.in_(task_ids))
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        return query.all()

    def list_recent_group_chat_tasks(
        self,
        db: Session,
        *,
        since: datetime,
    ) -> list[TaskResource]:
        tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.kind == "Task",
                TaskResource.updated_at >= since,
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
            )
            .all()
        )
        return [task for task in tasks if self._is_group_chat_task(task)]

    def list_regular_active_tasks(
        self,
        db: Session,
        *,
        user_id: Optional[int] = None,
        user_ids: Optional[Sequence[int]] = None,
        client_origin: Optional[str] = None,
        exclude_system_namespace: bool = False,
        limit: Optional[int] = None,
        order_by_id_desc: bool = False,
        order_by_updated_at_desc: bool = False,
    ) -> list[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        if user_id is not None:
            query = query.filter(TaskResource.user_id == user_id)
        if user_ids:
            query = query.filter(TaskResource.user_id.in_(user_ids))
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        if exclude_system_namespace:
            query = query.filter(TaskResource.namespace != "system")
        if order_by_id_desc:
            query = query.order_by(TaskResource.id.desc())
        if order_by_updated_at_desc:
            query = query.order_by(TaskResource.updated_at.desc())
        if limit is not None:
            query = query.limit(limit)
        return query.all()

    def list_kind_resources(
        self,
        db: Session,
        *,
        kind: str,
        user_id: int,
        namespace: str,
        name: Optional[str] = None,
    ) -> list[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.kind == kind,
            TaskResource.namespace == namespace,
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        if namespace == "default":
            query = query.filter(TaskResource.user_id == user_id)
        if name:
            query = query.filter(TaskResource.name == name)
        return query.all()

    def get_kind_resource(
        self,
        db: Session,
        *,
        kind: str,
        user_id: int,
        namespace: str,
        name: str,
    ) -> Optional[TaskResource]:
        resources = self.list_kind_resources(
            db,
            kind=kind,
            user_id=user_id,
            namespace=namespace,
            name=name,
        )
        return resources[0] if resources else None

    def create_kind_resource(
        self,
        db: Session,
        *,
        user_id: int,
        kind: str,
        name: str,
        namespace: str,
        payload: dict[str, Any],
    ) -> TaskResource:
        resource = TaskResource(
            user_id=user_id,
            kind=kind,
            name=name,
            namespace=namespace,
            json=payload,
        )
        db.add(resource)
        return resource

    def list_owned_tasks_by_ids_and_states(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        user_id: int,
        states: Sequence[int],
        client_origin: Optional[str] = None,
    ) -> list[TaskResource]:
        if not task_ids or not states:
            return []
        query = db.query(TaskResource).filter(
            TaskResource.id.in_(task_ids),
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.in_(states),
        )
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.all()

    def list_by_ids_ordered(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
        order_field: str = "updated_at",
        descending: bool = True,
        skip: int = 0,
        limit: Optional[int] = None,
        exclude_deleted: bool = False,
    ) -> list[TaskResource]:
        if not task_ids:
            return []
        if order_field not in {"id", "created_at", "updated_at"}:
            raise ValueError(f"Unsupported order_field: {order_field}")

        query = db.query(TaskResource).filter(TaskResource.id.in_(task_ids))
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if exclude_deleted:
            query = query.filter(
                text(
                    "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')), '') != 'DELETE'"
                )
            )
        order_column = getattr(TaskResource, order_field)
        query = query.order_by(
            order_column.desc() if descending else order_column.asc()
        )
        if skip:
            query = query.offset(skip)
        if limit is not None:
            query = query.limit(limit)
        return query.all()

    def list_workspaces_by_refs(
        self, db: Session, *, refs: Sequence[WorkspaceRefLookup]
    ) -> list[TaskResource]:
        if not refs:
            return []
        ref_tuples = [(ref.user_id, ref.namespace, ref.name) for ref in refs]
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.kind == "Workspace",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
                tuple_(
                    TaskResource.user_id,
                    TaskResource.namespace,
                    TaskResource.name,
                ).in_(ref_tuples),
            )
            .all()
        )

    def list_accessible_task_ids(
        self, db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
    ) -> tuple[list[int], int]:
        total = _timed_scalar(
            db,
            _ACCESSIBLE_COUNT_SQL,
            {
                "user_id": user_id,
                "entity_id": str(user_id),
                "is_active": TaskResource.STATE_ACTIVE,
            },
            "accessible_total",
        )
        rows = _timed_rows(
            db,
            _ACCESSIBLE_IDS_SQL,
            {
                "user_id": user_id,
                "entity_id": str(user_id),
                "is_active": TaskResource.STATE_ACTIVE,
                "limit": limit + extra_limit,
                "skip": skip,
            },
            "accessible_ids",
        )
        return [row[0] for row in rows], total

    def list_owned_task_ids(
        self, db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
    ) -> tuple[list[int], int]:
        total = _timed_scalar(
            db,
            _OWNED_COUNT_SQL,
            {
                "user_id": user_id,
                "is_active": TaskResource.STATE_ACTIVE,
            },
            "owned_total",
        )
        rows = _timed_rows(
            db,
            _OWNED_IDS_SQL,
            {
                "user_id": user_id,
                "is_active": TaskResource.STATE_ACTIVE,
                "limit": limit + extra_limit,
                "skip": skip,
            },
            "owned_ids",
        )
        return [row[0] for row in rows], total

    def list_personal_task_ids(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int,
        limit: int,
        extra_limit: int,
        client_origin: Optional[str] = None,
        project_scope: Literal["all", "standalone"] = "all",
    ) -> tuple[list[int], int]:
        if project_scope == "standalone":
            count_sql = (
                _PERSONAL_STANDALONE_COUNT_BY_ORIGIN_SQL
                if client_origin
                else _PERSONAL_STANDALONE_COUNT_SQL
            )
            ids_sql = (
                _PERSONAL_STANDALONE_IDS_BY_ORIGIN_SQL
                if client_origin
                else _PERSONAL_STANDALONE_IDS_SQL
            )
        else:
            count_sql = (
                _PERSONAL_COUNT_BY_ORIGIN_SQL if client_origin else _PERSONAL_COUNT_SQL
            )
            ids_sql = (
                _PERSONAL_IDS_BY_ORIGIN_SQL if client_origin else _PERSONAL_IDS_SQL
            )
        params: dict[str, object] = {
            "user_id": user_id,
            "is_active": TaskResource.STATE_ACTIVE,
            "limit": limit + extra_limit,
            "skip": skip,
        }
        if client_origin:
            params["client_origin"] = client_origin

        total = _timed_scalar(db, count_sql, params, "personal_total")
        rows = _timed_rows(db, ids_sql, params, "personal_ids")
        return [row[0] for row in rows], total

    def list_group_task_ids_for_accessible_user(
        self, db: Session, *, user_id: int
    ) -> set[int]:
        owned_rows = _timed_rows(
            db,
            _OWNED_GROUP_CHAT_SQL,
            {
                "user_id": user_id,
                "is_active": TaskResource.STATE_ACTIVE,
            },
            "owned_group_chat",
        )
        member_rows = _timed_rows(
            db,
            _MEMBER_TASK_IDS_SQL,
            {
                "entity_id": str(user_id),
                "is_active": TaskResource.STATE_ACTIVE,
            },
            "member_task_ids",
        )
        return {row[0] for row in owned_rows} | {row[0] for row in member_rows}

    def list_group_task_ids_for_owned_tasks(
        self, db: Session, *, user_id: int
    ) -> set[int]:
        rows = _timed_rows(
            db,
            _OWNED_GROUP_CHAT_SQL,
            {
                "user_id": user_id,
                "is_active": TaskResource.STATE_ACTIVE,
            },
            "owned_group_chat_only",
        )
        return {row[0] for row in rows}

    def list_active_tasks_for_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        return (
            db.query(TaskResource)
            .filter(
                TaskResource.kind == "Task",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
                TaskResource.user_id == user_id,
            )
            .all()
        )

    def list_accessible_active_tasks_for_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        return (
            db.query(TaskResource)
            .outerjoin(
                ResourceMember,
                (ResourceMember.resource_id == TaskResource.id)
                & (ResourceMember.resource_type == ResourceType.TASK)
                & (ResourceMember.entity_type == "user")
                & (ResourceMember.entity_id == str(user_id))
                & (ResourceMember.status == MemberStatus.APPROVED),
            )
            .filter(
                TaskResource.kind == "Task",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
                (TaskResource.user_id == user_id) | (ResourceMember.id.isnot(None)),
            )
            .all()
        )

    def count_non_deleted_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
    ) -> int:
        if not task_ids:
            return 0
        query = db.query(func.count(TaskResource.id)).filter(
            TaskResource.id.in_(task_ids),
            text(
                "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')), '') != 'DELETE'"
            ),
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        count_value = query.scalar()
        return int(count_value or 0)

    def count_active_project_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> int:
        query = db.query(func.count(TaskResource.id)).filter(
            TaskResource.project_id == project_id,
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return int(query.scalar() or 0)

    def list_active_project_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> list[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.project_id == project_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.order_by(TaskResource.updated_at.desc()).all()

    def get_active_project_task(
        self,
        db: Session,
        *,
        task_id: int,
        project_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.id == task_id,
            TaskResource.project_id == project_id,
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_owner_user_id(query, owner_user_id=owner_user_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.first()

    def list_archived_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        client_origin: Optional[str] = None,
    ) -> tuple[list[TaskResource], int]:
        query = db.query(TaskResource).filter(
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.namespace != "system",
            TaskResource.is_active == TaskResource.STATE_ARCHIVED,
        )
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        total = query.count()
        tasks = (
            query.order_by(TaskResource.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return tasks, total

    def list_archivable_active_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        scope: Literal["all", "standalone", "project", "project_id"],
        project_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> list[TaskResource]:
        query = db.query(TaskResource).filter(
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.namespace != "system",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        if scope == "standalone":
            query = query.filter(TaskResource.project_id == 0)
        elif scope == "project":
            query = query.filter(TaskResource.project_id > 0)
        elif scope == "project_id":
            query = query.filter(TaskResource.project_id == project_id)
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.all()

    def list_archived_task_ids(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> list[int]:
        query = db.query(TaskResource.id).filter(
            TaskResource.user_id == user_id,
            TaskResource.kind == "Task",
            TaskResource.namespace != "system",
            TaskResource.is_active == TaskResource.STATE_ARCHIVED,
        )
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return [row[0] for row in query.all()]

    def update_json(
        self, db: Session, *, task: TaskResource, payload: dict[str, Any]
    ) -> TaskResource:
        task.json = payload
        task.updated_at = datetime.now()
        self._flag_json_modified(task)
        return task

    def update_fields(
        self, db: Session, *, task: TaskResource, **fields: Any
    ) -> TaskResource:
        for field, value in fields.items():
            setattr(task, field, value)
        task.updated_at = datetime.now()
        return task

    def clear_project_for_owned_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> int:
        query = db.query(TaskResource).filter(
            TaskResource.project_id == project_id,
            TaskResource.user_id == user_id,
        )
        if client_origin:
            query = query.filter(TaskResource.client_origin == client_origin)
        return query.update({TaskResource.project_id: 0}, synchronize_session=False)

    def restore_stale_project_links_from_label(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        project_id: int,
    ) -> int:
        stale_tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.client_origin == client_origin,
                TaskResource.kind == "Task",
                TaskResource.project_id == 0,
                TaskResource.is_active != TaskResource.STATE_DELETED,
            )
            .all()
        )
        restored_count = 0
        for task in stale_tasks:
            if self._task_project_label(task) != str(project_id):
                continue
            task.project_id = project_id
            restored_count += 1
        return restored_count

    def set_archive_state(
        self, db: Session, *, task: TaskResource, state: int, commit: bool = True
    ) -> None:
        original_updated_at = task.updated_at
        db.query(TaskResource).filter(TaskResource.id == task.id).update(
            {
                TaskResource.is_active: state,
                TaskResource.updated_at: original_updated_at,
            },
            synchronize_session="fetch",
        )
        if commit:
            db.commit()

    def soft_delete_task(
        self, db: Session, *, task: TaskResource, payload: dict[str, Any]
    ) -> TaskResource:
        task.json = payload
        task.updated_at = datetime.now()
        task.is_active = TaskResource.STATE_DELETED
        self._flag_json_modified(task)
        return task

    def delete_resource(self, db: Session, *, resource: TaskResource) -> None:
        db.delete(resource)

    def _flag_json_modified(self, task: TaskResource) -> None:
        flag_modified(task, "json")

    def _is_group_chat_task(self, task: TaskResource) -> bool:
        if task.is_group_chat is True:
            return True
        payload = task.json if isinstance(task.json, dict) else {}
        return payload.get("spec", {}).get("is_group_chat") is True

    @staticmethod
    def _task_project_label(task: TaskResource) -> Optional[str]:
        task_json = task.json or {}
        if not isinstance(task_json, dict):
            return None
        metadata = task_json.get("metadata")
        if not isinstance(metadata, dict):
            return None
        labels = metadata.get("labels")
        if not isinstance(labels, dict):
            return None
        value = labels.get("projectId")
        if value is None:
            return None
        return str(value)
