from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime
from time import perf_counter
from typing import Any, Callable

from sqlalchemy import and_, exists, func, or_, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.interfaces import TaskIdAllocationError
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore
from wecode.task_sharding.global_id_allocator import (
    GlobalIdAllocator,
    allocate_task_id,
)
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.task_id import (
    is_new_task_id,
)

MAX_TASK_ID_INSERT_ATTEMPTS = 3
logger = logging.getLogger(__name__)


class ShardedTaskStore(SqlAlchemyTaskStore):
    """Internal task store that writes new Task/Workspace rows to task shards."""

    def __init__(
        self,
        *,
        global_id_allocator: GlobalIdAllocator | None = None,
    ) -> None:
        self.global_id_allocator = global_id_allocator

    def get_by_id(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(model.id == task_id)
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        return query.first()

    def get_by_id_for_update(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(model.id == task_id)
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        return query.with_for_update().one_or_none()

    def is_valid_task_id(
        self, db: Session, *, task_id: int, owner_user_id: int | None = None
    ) -> bool:
        if not is_new_task_id(task_id):
            return super().is_valid_task_id(
                db, task_id=task_id, owner_user_id=owner_user_id
            )

        return (
            self.get_by_id(db, task_id=task_id, owner_user_id=owner_user_id) is not None
        )

    def get_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(
            model.id == task_id,
            model.kind == "Task",
            model.is_active.in_(TaskResource.is_active_query()),
        )
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query.first()

    def get_non_deleted_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(
            model.id == task_id,
            model.kind == "Task",
            model.is_active != TaskResource.STATE_DELETED,
        )
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        return query.first()

    def get_regular_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(
            model.id == task_id,
            model.kind == "Task",
            model.namespace != "system",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query.first()

    def get_owned_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        return self.get_task_by_states(
            db,
            task_id=task_id,
            states=[TaskResource.STATE_ACTIVE],
            user_id=user_id,
            client_origin=client_origin,
        )

    def get_owned_task_by_name(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> TaskResource | None:
        model = task_model_for_user(user_id)
        task = (
            db.query(model)
            .filter(
                model.user_id == user_id,
                model.kind == "Task",
                model.namespace == namespace,
                model.name == name,
                model.is_active == TaskResource.STATE_ACTIVE,
            )
            .first()
        )
        if task is not None:
            return task
        return super().get_owned_task_by_name(
            db, user_id=user_id, name=name, namespace=namespace
        )

    def get_active_non_deleted_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        if not is_new_task_id(task_id):
            return super().get_active_non_deleted_task(
                db,
                task_id=task_id,
                owner_user_id=owner_user_id,
                client_origin=client_origin,
            )

        task = self.get_task_by_states(
            db,
            task_id=task_id,
            states=TaskResource.is_active_query(),
            owner_user_id=owner_user_id,
            client_origin=client_origin,
        )
        if task is None or self._is_json_deleted(task):
            return None
        return task

    def get_active_or_archived_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        return self.get_task_by_states(
            db,
            task_id=task_id,
            states=[TaskResource.STATE_ACTIVE, TaskResource.STATE_ARCHIVED],
            owner_user_id=owner_user_id,
            client_origin=client_origin,
        )

    def get_task_by_states(
        self,
        db: Session,
        *,
        task_id: int,
        states: Sequence[int],
        kind: str = "Task",
        user_id: int | None = None,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        if not states:
            return None

        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(
            model.id == task_id,
            model.kind == kind,
            model.is_active.in_(states),
        )
        if user_id is not None:
            query = query.filter(model.user_id == user_id)
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query.first()

    def get_owned_task_by_state(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        state: int,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        return self.get_task_by_states(
            db,
            task_id=task_id,
            states=[state],
            user_id=user_id,
            client_origin=client_origin,
        )

    def get_task_by_workspace_ref(
        self,
        db: Session,
        *,
        user_id: int,
        workspace_name: str,
        workspace_namespace: str,
    ) -> TaskResource | None:
        model = task_model_for_user(user_id)
        tasks = (
            db.query(model)
            .filter(
                model.user_id == user_id,
                model.kind == "Task",
                model.is_active.in_(TaskResource.is_active_query()),
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
        return super().get_task_by_workspace_ref(
            db,
            user_id=user_id,
            workspace_name=workspace_name,
            workspace_namespace=workspace_namespace,
        )

    def get_workspace_by_ref(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> TaskResource | None:
        model = task_model_for_user(user_id)
        workspace = (
            db.query(model)
            .filter(
                model.user_id == user_id,
                model.kind == "Workspace",
                model.name == name,
                model.namespace == namespace,
                model.is_active == TaskResource.STATE_ACTIVE,
            )
            .first()
        )
        if workspace is not None:
            return workspace
        return super().get_workspace_by_ref(
            db, user_id=user_id, name=name, namespace=namespace
        )

    def get_active_workspace_by_id(
        self,
        db: Session,
        *,
        workspace_id: int,
        owner_user_id: int | None = None,
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=workspace_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(
            model.id == workspace_id,
            model.kind == "Workspace",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        return query.first()

    def get_owned_active_workspace_by_id(
        self, db: Session, *, workspace_id: int, user_id: int
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=workspace_id, owner_user_id=user_id
        )
        if model is None:
            return None
        return (
            db.query(model)
            .filter(
                model.id == workspace_id,
                model.user_id == user_id,
                model.kind == "Workspace",
                model.is_active == TaskResource.STATE_ACTIVE,
            )
            .first()
        )

    def list_active_workspaces_by_ids(
        self,
        db: Session,
        *,
        workspace_ids: Sequence[int],
        owner_user_id: int | None = None,
    ) -> list[TaskResource]:
        if not workspace_ids:
            return []

        legacy_ids, shard_ids_by_model = self._split_task_ids_by_model(workspace_ids)
        legacy_workspaces = super().list_active_workspaces_by_ids(
            db, workspace_ids=legacy_ids, owner_user_id=owner_user_id
        )
        legacy_workspaces = self._exclude_migrated_legacy_index_rows(
            db, legacy_workspaces
        )
        migrated_legacy_workspaces = [
            workspace
            for workspace in self._list_migrated_legacy_tasks_by_ids(
                db, task_ids=legacy_ids, owner_user_id=owner_user_id
            )
            if workspace.kind == "Workspace"
            and workspace.is_active == TaskResource.STATE_ACTIVE
        ]
        workspaces = [*migrated_legacy_workspaces, *legacy_workspaces]
        for model, shard_ids in shard_ids_by_model.items():
            query = db.query(model).filter(
                model.id.in_(shard_ids),
                model.kind == "Workspace",
                model.is_active == TaskResource.STATE_ACTIVE,
            )
            query = self._filter_model_owner_user_id(
                query, model, owner_user_id=owner_user_id
            )
            workspaces.extend(query.all())
        return self._order_by_input_ids(
            self._deduplicate_tasks_by_id(workspaces), workspace_ids
        )

    def list_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: int | None = None,
    ) -> list[TaskResource]:
        if not task_ids:
            return []

        legacy_ids, shard_ids_by_model = self._split_task_ids_by_model(task_ids)
        legacy_tasks = super().list_by_ids(
            db, task_ids=legacy_ids, owner_user_id=owner_user_id
        )
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        migrated_legacy_tasks = self._list_migrated_legacy_tasks_by_ids(
            db, task_ids=legacy_ids, owner_user_id=owner_user_id
        )
        tasks = [*migrated_legacy_tasks, *legacy_tasks]
        for model, shard_ids in shard_ids_by_model.items():
            query = db.query(model).filter(model.id.in_(shard_ids))
            query = self._filter_model_owner_user_id(
                query, model, owner_user_id=owner_user_id
            )
            tasks.extend(query.all())
        return self._deduplicate_tasks_by_id(tasks)

    def list_recent_group_chat_tasks(
        self,
        db: Session,
        *,
        since: datetime,
    ) -> list[TaskResource]:
        legacy_tasks = self._exclude_migrated_legacy_index_rows(
            db, super().list_recent_group_chat_tasks(db, since=since)
        )
        shard_tasks: list[TaskResource] = []
        for uid in range(SHARD_COUNT):
            model = task_model_for_user(uid)
            model_tasks = (
                db.query(model)
                .filter(
                    model.kind == "Task",
                    model.updated_at >= since,
                    model.is_active == TaskResource.STATE_ACTIVE,
                )
                .all()
            )
            shard_tasks.extend(
                task for task in model_tasks if self._is_group_chat_task(task)
            )
        return self._deduplicate_tasks_by_id([*shard_tasks, *legacy_tasks])

    def list_active_workspaces_by_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        model = task_model_for_user(user_id)
        shard_workspaces = (
            db.query(model)
            .filter(
                model.user_id == user_id,
                model.kind == "Workspace",
                model.is_active == TaskResource.STATE_ACTIVE,
            )
            .all()
        )
        legacy_workspaces = self._exclude_migrated_legacy_index_rows(
            db, super().list_active_workspaces_by_user(db, user_id=user_id)
        )
        return self._deduplicate_tasks_by_id([*shard_workspaces, *legacy_workspaces])

    def list_regular_active_tasks(
        self,
        db: Session,
        *,
        user_id: int | None = None,
        user_ids: Sequence[int] | None = None,
        client_origin: str | None = None,
        exclude_system_namespace: bool = False,
        limit: int | None = None,
        order_by_id_desc: bool = False,
        order_by_updated_at_desc: bool = False,
    ) -> list[TaskResource]:
        shard_user_ids = self._owner_user_ids_for_query(user_id, user_ids)
        if not shard_user_ids:
            return super().list_regular_active_tasks(
                db,
                user_id=user_id,
                user_ids=user_ids,
                client_origin=client_origin,
                exclude_system_namespace=exclude_system_namespace,
                limit=limit,
                order_by_id_desc=order_by_id_desc,
                order_by_updated_at_desc=order_by_updated_at_desc,
            )

        legacy_tasks = super().list_regular_active_tasks(
            db,
            user_id=user_id,
            user_ids=user_ids,
            client_origin=client_origin,
            exclude_system_namespace=exclude_system_namespace,
            limit=None,
            order_by_id_desc=False,
            order_by_updated_at_desc=False,
        )
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        shard_tasks: list[TaskResource] = []
        for model, model_user_ids in self._owner_user_ids_by_model(
            shard_user_ids
        ).items():
            query = self._regular_active_tasks_query(
                db,
                model,
                user_id=user_id if user_id is not None else None,
                user_ids=None if user_id is not None else model_user_ids,
                client_origin=client_origin,
                exclude_system_namespace=exclude_system_namespace,
            )
            shard_tasks.extend(query.all())

        tasks = self._deduplicate_tasks_by_id([*shard_tasks, *legacy_tasks])
        tasks = self._order_tasks(
            tasks,
            order_by_id_desc=order_by_id_desc,
            order_by_updated_at_desc=order_by_updated_at_desc,
        )
        if limit is not None:
            tasks = tasks[:limit]
        return tasks

    def list_recent_owner_only_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        limit: int,
        client_origin: str | None = None,
    ) -> list[TaskResource]:
        """Return recent private Tasks from the current user's task shard."""
        if limit <= 0:
            return []

        model = task_model_for_user(user_id)
        approved_member_exists = exists().where(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == model.id,
            ResourceMember.status == MemberStatus.APPROVED,
        )
        query = db.query(model).filter(
            model.user_id == user_id,
            model.kind == "Task",
            model.is_active == TaskResource.STATE_ACTIVE,
            model.is_group_chat.is_(False),
            ~approved_member_exists,
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return (
            query.order_by(model.updated_at.desc(), model.id.desc()).limit(limit).all()
        )

    def list_kind_resources(
        self,
        db: Session,
        *,
        kind: str,
        user_id: int,
        namespace: str,
        name: str | None = None,
    ) -> list[TaskResource]:
        model = task_model_for_user(user_id)
        query = db.query(model).filter(
            model.kind == kind,
            model.namespace == namespace,
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        if namespace == "default":
            query = query.filter(model.user_id == user_id)
        if name:
            query = query.filter(model.name == name)
        shard_resources = query.all()
        legacy_resources = super().list_kind_resources(
            db,
            kind=kind,
            user_id=user_id,
            namespace=namespace,
            name=name,
        )
        legacy_resources = self._exclude_migrated_legacy_index_rows(
            db, legacy_resources
        )
        return self._deduplicate_tasks_by_id([*shard_resources, *legacy_resources])

    def get_kind_resource(
        self,
        db: Session,
        *,
        kind: str,
        user_id: int,
        namespace: str,
        name: str,
    ) -> TaskResource | None:
        resources = self.list_kind_resources(
            db,
            kind=kind,
            user_id=user_id,
            namespace=namespace,
            name=name,
        )
        return resources[0] if resources else None

    def list_owned_tasks_by_ids_and_states(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        user_id: int,
        states: Sequence[int],
        client_origin: str | None = None,
    ) -> list[TaskResource]:
        if not task_ids or not states:
            return []

        legacy_ids, shard_ids_by_model = self._split_task_ids_by_model(task_ids)
        legacy_tasks = super().list_owned_tasks_by_ids_and_states(
            db,
            task_ids=legacy_ids,
            user_id=user_id,
            states=states,
            client_origin=client_origin,
        )
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        migrated_legacy_tasks = [
            task
            for task in self._list_migrated_legacy_tasks_by_ids(
                db, task_ids=legacy_ids, owner_user_id=user_id
            )
            if task.kind == "Task" and task.is_active in states
        ]
        if client_origin:
            migrated_legacy_tasks = [
                task
                for task in migrated_legacy_tasks
                if task.client_origin == client_origin
            ]
        tasks = [*migrated_legacy_tasks, *legacy_tasks]
        for model, shard_ids in shard_ids_by_model.items():
            query = db.query(model).filter(
                model.id.in_(shard_ids),
                model.user_id == user_id,
                model.kind == "Task",
                model.is_active.in_(states),
            )
            if client_origin:
                query = query.filter(model.client_origin == client_origin)
            tasks.extend(query.all())
        return self._order_by_input_ids(self._deduplicate_tasks_by_id(tasks), task_ids)

    def list_workspaces_by_refs(
        self, db: Session, *, refs: Sequence
    ) -> list[TaskResource]:
        if not refs:
            return []

        workspaces = super().list_workspaces_by_refs(db, refs=refs)
        for model, model_refs in self._workspace_refs_by_model(refs).items():
            ref_tuples = [(ref.user_id, ref.namespace, ref.name) for ref in model_refs]
            workspaces.extend(
                db.query(model)
                .filter(
                    model.kind == "Workspace",
                    model.is_active == TaskResource.STATE_ACTIVE,
                    tuple_(model.user_id, model.namespace, model.name).in_(ref_tuples),
                )
                .all()
            )
        return self._order_workspaces_by_refs(workspaces, refs)

    def list_api_workspaces_by_refs(
        self, db: Session, *, refs: Sequence
    ) -> list[TaskResource]:
        """Load task-list workspace metadata exclusively from hash shards."""
        if not refs:
            return []

        workspaces: list[TaskResource] = []
        for model, model_refs in self._workspace_refs_by_model(refs).items():
            ref_tuples = [(ref.user_id, ref.namespace, ref.name) for ref in model_refs]
            workspaces.extend(
                db.query(model)
                .filter(
                    model.kind == "Workspace",
                    model.is_active == TaskResource.STATE_ACTIVE,
                    tuple_(model.user_id, model.namespace, model.name).in_(ref_tuples),
                )
                .all()
            )
        return self._order_workspaces_by_refs(workspaces, refs)

    def list_archived_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        client_origin: str | None = None,
    ) -> tuple[list[TaskResource], int]:
        legacy_tasks = self._archived_tasks_query(
            db,
            TaskResource,
            user_id=user_id,
            client_origin=client_origin,
        ).all()
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        model = task_model_for_user(user_id)
        shard_tasks = self._archived_tasks_query(
            db,
            model,
            user_id=user_id,
            client_origin=client_origin,
        ).all()
        tasks = self._deduplicate_tasks_by_id([*shard_tasks, *legacy_tasks])
        tasks.sort(key=lambda task: task.updated_at, reverse=True)
        total = len(tasks)
        return tasks[skip : skip + limit], total

    def list_archivable_active_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        scope: str,
        project_id: int | None = None,
        client_origin: str | None = None,
    ) -> list[TaskResource]:
        legacy_tasks = self._archivable_active_tasks_query(
            db,
            TaskResource,
            user_id=user_id,
            scope=scope,
            project_id=project_id,
            client_origin=client_origin,
        ).all()
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        model = task_model_for_user(user_id)
        shard_tasks = self._archivable_active_tasks_query(
            db,
            model,
            user_id=user_id,
            scope=scope,
            project_id=project_id,
            client_origin=client_origin,
        ).all()
        return self._deduplicate_tasks_by_id([*shard_tasks, *legacy_tasks])

    def count_active_project_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> int:
        if owner_user_id is None:
            return super().count_active_project_tasks(
                db,
                project_id=project_id,
                owner_user_id=owner_user_id,
                client_origin=client_origin,
            )
        return len(
            self.list_active_project_tasks(
                db,
                project_id=project_id,
                owner_user_id=owner_user_id,
                client_origin=client_origin,
            )
        )

    def list_active_project_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> list[TaskResource]:
        legacy_tasks = super().list_active_project_tasks(
            db,
            project_id=project_id,
            owner_user_id=owner_user_id,
            client_origin=client_origin,
        )
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        if owner_user_id is None:
            return legacy_tasks

        model = task_model_for_user(owner_user_id)
        query = db.query(model).filter(
            model.project_id == project_id,
            model.user_id == owner_user_id,
            model.kind == "Task",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        tasks = self._deduplicate_tasks_by_id([*query.all(), *legacy_tasks])
        return sorted(tasks, key=lambda task: task.updated_at, reverse=True)

    def get_active_project_task(
        self,
        db: Session,
        *,
        task_id: int,
        project_id: int,
        owner_user_id: int | None = None,
        client_origin: str | None = None,
    ) -> TaskResource | None:
        model = self._model_for_task_id_lookup(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if model is None:
            return None
        query = db.query(model).filter(
            model.id == task_id,
            model.project_id == project_id,
            model.kind == "Task",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        query = self._filter_model_owner_user_id(
            query, model, owner_user_id=owner_user_id
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query.first()

    def count_non_deleted_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: int | None = None,
    ) -> int:
        tasks = self.list_by_ids(db, task_ids=task_ids, owner_user_id=owner_user_id)
        return sum(1 for task in tasks if not self._is_json_deleted(task))

    def list_archived_task_ids(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str | None = None,
    ) -> list[int]:
        legacy_tasks = self._archived_tasks_query(
            db,
            TaskResource,
            user_id=user_id,
            client_origin=client_origin,
        ).all()
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        legacy_task_ids = [task.id for task in legacy_tasks]
        model = task_model_for_user(user_id)
        query = db.query(model.id).filter(
            model.user_id == user_id,
            model.kind == "Task",
            model.namespace != "system",
            model.is_active == TaskResource.STATE_ARCHIVED,
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        shard_task_ids = [row[0] for row in query.all()]
        return self._deduplicate_task_ids([*shard_task_ids, *legacy_task_ids])

    def clear_project_for_owned_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        client_origin: str | None = None,
    ) -> int:
        updated = self._clear_project_for_model(
            db,
            TaskResource,
            project_id=project_id,
            user_id=user_id,
            client_origin=client_origin,
        )
        model = task_model_for_user(user_id)
        updated += self._clear_project_for_model(
            db,
            model,
            project_id=project_id,
            user_id=user_id,
            client_origin=client_origin,
        )
        return updated

    def set_archive_state(
        self, db: Session, *, task: TaskResource, state: int, commit: bool = True
    ) -> None:
        original_updated_at = task.updated_at
        task.is_active = state
        task.updated_at = original_updated_at
        if commit:
            db.commit()

    def list_owned_task_ids(
        self, db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
    ) -> tuple[list[int], int]:
        tasks, total = self._owned_active_task_page_and_total(
            db,
            user_id=user_id,
            skip=skip,
            limit=limit + extra_limit,
            exclude_system_namespace=True,
        )
        return ([task.id for task in tasks], total)

    def list_personal_task_ids(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int,
        limit: int,
        extra_limit: int,
        client_origin: str | None = None,
    ) -> tuple[list[int], int]:
        query_limit = limit + extra_limit
        model = task_model_for_user(user_id)
        query = self._owned_active_task_query(
            db,
            model,
            user_id=user_id,
            exclude_system_namespace=True,
            is_group_chat=False,
            client_origin=client_origin,
            project_id=0,
        )
        total = self._count_query_rows(query)
        rows = (
            query.with_entities(model.id)
            .order_by(model.created_at.desc(), model.id.desc())
            .offset(skip)
            .limit(query_limit)
            .all()
        )
        return ([row[0] for row in rows], total)

    def list_personal_task_candidates_after(
        self,
        db: Session,
        *,
        user_id: int,
        limit: int,
        cursor_created_at: datetime | None = None,
        cursor_id: int | None = None,
        client_origin: str | None = None,
    ) -> list[TaskResource]:
        model = task_model_for_user(user_id)
        query = self._owned_active_task_query(
            db,
            model,
            user_id=user_id,
            exclude_system_namespace=True,
            is_group_chat=False,
            client_origin=client_origin,
            project_id=0,
        )
        if cursor_created_at is not None and cursor_id is not None:
            query = query.filter(
                or_(
                    model.created_at < cursor_created_at,
                    and_(
                        model.created_at == cursor_created_at,
                        model.id < cursor_id,
                    ),
                )
            )
        statement = (
            query.order_by(model.created_at.desc(), model.id.desc())
            .limit(limit)
            .statement
        )
        started_at = perf_counter()
        result = db.execute(statement)
        execute_ms = (perf_counter() - started_at) * 1000
        started_at = perf_counter()
        tasks = result.scalars().all()
        fetch_ms = (perf_counter() - started_at) * 1000
        logger.info(
            "[task_list_timing] personal_cursor_store user_id=%s limit=%s "
            "execute_ms=%.2f fetch_ms=%.2f rows=%s",
            user_id,
            limit,
            execute_ms,
            fetch_ms,
            len(tasks),
        )
        return tasks

    def list_accessible_task_ids(
        self, db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
    ) -> tuple[list[int], int]:
        page_limit = skip + limit + extra_limit
        owned_tasks, owned_total = self._owned_active_shard_task_page_and_total(
            db,
            user_id=user_id,
            limit=page_limit,
            exclude_system_namespace=True,
        )
        member_tasks = [
            task
            for task in self._member_shard_task_rows(db, user_id=user_id)
            if self._is_active_regular_task(task, exclude_system_namespace=True)
            and task.user_id != user_id
        ]
        member_tasks = self._deduplicate_tasks_by_id(member_tasks)
        ordered_tasks = self._order_tasks_by_created_at_desc(
            self._deduplicate_tasks_by_id([*owned_tasks, *member_tasks])
        )
        total = owned_total + len(member_tasks)
        return (
            self._page_task_ids(ordered_tasks, skip=skip, limit=limit + extra_limit),
            total,
        )

    def list_api_tasks_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: int | None = None,
    ) -> list[TaskResource]:
        """Load task-list rows exclusively from shard tables."""
        tasks = self._list_shard_tasks_by_ids(db, task_ids=task_ids)
        if owner_user_id is not None:
            tasks = [task for task in tasks if task.user_id == owner_user_id]
        return self._deduplicate_tasks_by_id(tasks)

    def list_group_task_ids_for_accessible_user(
        self, db: Session, *, user_id: int
    ) -> set[int]:
        owned_tasks = self._owned_active_task_rows(
            db,
            user_id=user_id,
            exclude_system_namespace=True,
            is_group_chat=True,
        )
        member_tasks = [
            task
            for task in self._member_task_rows(db, user_id=user_id)
            if self._is_active_regular_task(
                task,
                exclude_system_namespace=True,
                is_group_chat=True,
            )
        ]
        return {
            task.id
            for task in self._deduplicate_tasks_by_id([*owned_tasks, *member_tasks])
        }

    def list_group_task_ids_for_owned_tasks(
        self, db: Session, *, user_id: int
    ) -> set[int]:
        tasks = self._owned_active_task_rows(
            db,
            user_id=user_id,
            exclude_system_namespace=True,
            is_group_chat=True,
        )
        return {task.id for task in tasks}

    def list_active_tasks_for_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        return self._owned_active_task_rows(db, user_id=user_id)

    def list_accessible_active_tasks_for_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        owned_tasks = self._owned_active_task_rows(db, user_id=user_id)
        member_tasks = [
            task
            for task in self._member_task_rows(db, user_id=user_id)
            if self._is_active_regular_task(task)
        ]
        return self._deduplicate_tasks_by_id([*owned_tasks, *member_tasks])

    def list_by_ids_ordered(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: int | None = None,
        order_field: str = "updated_at",
        descending: bool = True,
        skip: int = 0,
        limit: int | None = None,
        exclude_deleted: bool = False,
    ) -> list[TaskResource]:
        if not task_ids:
            return []
        if order_field not in {"id", "created_at", "updated_at"}:
            raise ValueError(f"Unsupported order_field: {order_field}")

        tasks = self.list_by_ids(db, task_ids=task_ids, owner_user_id=owner_user_id)
        if exclude_deleted:
            tasks = [task for task in tasks if not self._is_json_deleted(task)]
        tasks_by_id = {task.id: task for task in tasks}
        ordered_tasks = [
            tasks_by_id[task_id] for task_id in task_ids if task_id in tasks_by_id
        ]
        if skip:
            ordered_tasks = ordered_tasks[skip:]
        if limit is not None:
            ordered_tasks = ordered_tasks[:limit]
        return ordered_tasks

    def create_placeholder_task_id(self, db: Session, *, user_id: int) -> int:
        last_integrity_error: IntegrityError | None = None
        for _ in range(MAX_TASK_ID_INSERT_ATTEMPTS):
            try:
                task_id = self._allocate_task_id(user_id)
            except Exception as exc:
                raise TaskIdAllocationError("Failed to allocate task ID") from exc

            model = task_model_for_user(user_id)
            placeholder_name = f"temp-placeholder-{uuid.uuid4().hex}"
            placeholder = model(
                id=task_id,
                user_id=user_id,
                kind="Placeholder",
                name=placeholder_name,
                namespace="default",
                json={
                    "kind": "Placeholder",
                    "metadata": {
                        "name": placeholder_name,
                        "namespace": "default",
                    },
                },
                is_active=TaskResource.STATE_DELETED,
                client_origin="frontend",
            )
            try:
                with db.begin_nested():
                    db.add(placeholder)
                    db.flush()
                return task_id
            except IntegrityError as exc:
                last_integrity_error = exc

        if last_integrity_error is not None:
            raise TaskIdAllocationError(
                "Failed to allocate task ID"
            ) from last_integrity_error
        raise TaskIdAllocationError("Failed to allocate task ID")

    def create_pending_task_shell(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        is_group_chat: bool = False,
        project_id: int = 0,
    ) -> TaskResource:
        return self._insert_with_generated_id(
            db,
            user_id=user_id,
            factory=lambda model, task_id: model(
                id=task_id,
                user_id=user_id,
                kind="Task",
                name=f"task-pending-{uuid.uuid4().hex}",
                namespace="default",
                json={"kind": "Task"},
                is_active=TaskResource.STATE_ACTIVE,
                is_group_chat=is_group_chat,
                client_origin=client_origin,
                project_id=project_id,
            ),
        )

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
        return self._insert_with_generated_id(
            db,
            user_id=user_id,
            factory=lambda model, task_id: model(
                id=task_id,
                user_id=user_id,
                kind="Workspace",
                name=name,
                namespace=namespace,
                json=payload,
                is_active=TaskResource.STATE_ACTIVE,
                client_origin=client_origin,
            ),
        )

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
        last_integrity_error: IntegrityError | None = None
        model = task_model_for_user(user_id)
        for _ in range(MAX_TASK_ID_INSERT_ATTEMPTS):
            task_id, workspace_id = self._allocate_task_ids(user_id, 2)
            workspace_name, workspace_namespace, workspace_payload = workspace_factory(
                task_id
            )
            task = model(
                id=task_id,
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
            workspace = model(
                id=workspace_id,
                user_id=user_id,
                kind="Workspace",
                name=workspace_name,
                namespace=workspace_namespace,
                json=workspace_payload,
                is_active=TaskResource.STATE_ACTIVE,
                client_origin=client_origin,
            )
            try:
                with db.begin_nested():
                    db.add_all([task, workspace])
                    db.flush()
                return task, workspace
            except IntegrityError as exc:
                last_integrity_error = exc

        if last_integrity_error is not None:
            raise last_integrity_error
        raise RuntimeError("Failed to insert task and workspace resources")

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
        if not is_new_task_id(task_id):
            return super().create_task(
                db,
                task_id=task_id,
                user_id=user_id,
                name=name,
                namespace=namespace,
                payload=payload,
                client_origin=client_origin,
                project_id=project_id,
                is_group_chat=is_group_chat,
            )

        model = task_model_for_user(user_id)
        task = (
            db.query(model)
            .filter(model.id == task_id, model.kind == "Placeholder")
            .first()
        )
        if task is None:
            task = model(id=task_id)
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
        return self._insert_with_generated_id(
            db,
            user_id=user_id,
            factory=lambda model, task_id: model(
                id=task_id,
                user_id=user_id,
                kind="Task",
                name=name,
                namespace=namespace,
                json=payload,
                is_active=state,
                client_origin=client_origin,
                project_id=project_id,
                is_group_chat=is_group_chat,
            ),
        )

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
        return self._insert_with_generated_id(
            db,
            user_id=user_id,
            factory=lambda model, task_id: model(
                id=task_id,
                user_id=user_id,
                kind=kind,
                name=name,
                namespace=namespace,
                json=payload,
                is_active=TaskResource.STATE_ACTIVE,
            ),
        )

    def _insert_with_generated_id(
        self,
        db: Session,
        *,
        user_id: int,
        factory: Callable[[type, int], TaskResource],
    ) -> TaskResource:
        last_integrity_error: IntegrityError | None = None
        for _ in range(MAX_TASK_ID_INSERT_ATTEMPTS):
            task_id = self._allocate_task_id(user_id)
            model = task_model_for_user(user_id)
            task = factory(model, task_id)
            try:
                with db.begin_nested():
                    db.add(task)
                    db.flush()
                return task
            except IntegrityError as exc:
                last_integrity_error = exc

        if last_integrity_error is not None:
            raise last_integrity_error
        raise RuntimeError("Failed to insert task resource")

    def _allocate_task_id(self, user_id: int) -> int:
        if self.global_id_allocator is None:
            raise TaskIdAllocationError("No global_id_allocator configured")
        task_id = allocate_task_id(self.global_id_allocator, user_id)
        if not is_new_task_id(task_id):
            raise TaskIdAllocationError(
                f"Allocated task id is not a user-scoped sharding id: {task_id}"
            )
        return task_id

    def _allocate_task_ids(self, user_id: int, count: int) -> list[int]:
        return [self._allocate_task_id(user_id) for _ in range(count)]

    def _model_for_task_id_lookup(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
    ) -> type | None:
        if not is_new_task_id(task_id):
            return (
                self._migrated_legacy_task_model(
                    db, task_id=task_id, owner_user_id=owner_user_id
                )
                or TaskResource
            )
        return task_model_for_task_id(task_id)

    def _migrated_legacy_task_model(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
    ) -> type | None:
        owner_user_id_from_index = self._legacy_task_owner_user_id(
            db, task_id=task_id, owner_user_id=owner_user_id
        )
        if owner_user_id_from_index is None:
            return None

        model = task_model_for_user(owner_user_id_from_index)
        exists = db.query(model.id).filter(model.id == task_id).first() is not None
        return model if exists else None

    def _legacy_task_owner_user_id(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: int | None = None,
    ) -> int | None:
        query = db.query(TaskResource.user_id).filter(TaskResource.id == task_id)
        if owner_user_id is not None:
            query = query.filter(TaskResource.user_id == owner_user_id)
        row = query.first()
        return int(row[0]) if row is not None else None

    def _list_migrated_legacy_tasks_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: int | None = None,
    ) -> list[TaskResource]:
        if not task_ids:
            return []

        query = db.query(TaskResource.id, TaskResource.user_id).filter(
            TaskResource.id.in_(task_ids)
        )
        if owner_user_id is not None:
            query = query.filter(TaskResource.user_id == owner_user_id)

        ids_by_model: dict[type, list[int]] = defaultdict(list)
        for task_id, user_id in query.all():
            ids_by_model[task_model_for_user(int(user_id))].append(int(task_id))

        tasks: list[TaskResource] = []
        for model, model_task_ids in ids_by_model.items():
            tasks.extend(db.query(model).filter(model.id.in_(model_task_ids)).all())
        return tasks

    def _exclude_migrated_legacy_index_rows(
        self, db: Session, legacy_rows: Sequence[TaskResource]
    ) -> list[TaskResource]:
        if not legacy_rows:
            return []

        ids_by_model: dict[type, list[int]] = defaultdict(list)
        for row in legacy_rows:
            ids_by_model[task_model_for_user(int(row.user_id))].append(int(row.id))

        migrated_ids: set[int] = set()
        for model, task_ids in ids_by_model.items():
            migrated_ids.update(
                row[0]
                for row in db.query(model.id).filter(model.id.in_(task_ids)).all()
            )
        return [row for row in legacy_rows if row.id not in migrated_ids]

    def _split_task_ids_by_model(
        self, task_ids: Sequence[int]
    ) -> tuple[list[int], dict[type, list[int]]]:
        legacy_ids: list[int] = []
        shard_ids_by_model: dict[type, list[int]] = defaultdict(list)
        for task_id in task_ids:
            if not is_new_task_id(task_id):
                legacy_ids.append(task_id)
                continue
            shard_ids_by_model[task_model_for_task_id(task_id)].append(task_id)
        return legacy_ids, dict(shard_ids_by_model)

    def _filter_model_owner_user_id(
        self,
        query,
        model: type,
        *,
        owner_user_id: int | None,
    ):
        if owner_user_id is None:
            return query
        return query.filter(model.user_id == owner_user_id)

    def _owner_user_ids_for_query(
        self, user_id: int | None, user_ids: Sequence[int] | None
    ) -> list[int]:
        if user_id is None and not user_ids:
            return []
        if user_id is not None:
            return [user_id]
        return sorted(set(user_ids or []))

    def _owner_user_ids_by_model(
        self, user_ids: Sequence[int]
    ) -> dict[type, list[int]]:
        user_ids_by_model: dict[type, list[int]] = defaultdict(list)
        for user_id in sorted(set(user_ids)):
            user_ids_by_model[task_model_for_user(user_id)].append(user_id)
        return dict(user_ids_by_model)

    def _workspace_refs_by_model(self, refs: Sequence) -> dict[type, list]:
        refs_by_model: dict[type, list] = defaultdict(list)
        for ref in refs:
            refs_by_model[task_model_for_user(ref.user_id)].append(ref)
        return dict(refs_by_model)

    def _regular_active_tasks_query(
        self,
        db: Session,
        model: type,
        *,
        user_id: int | None,
        user_ids: Sequence[int] | None,
        client_origin: str | None,
        exclude_system_namespace: bool,
    ):
        query = db.query(model).filter(
            model.kind == "Task",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        if user_id is not None:
            query = query.filter(model.user_id == user_id)
        if user_ids:
            query = query.filter(model.user_id.in_(user_ids))
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        if exclude_system_namespace:
            query = query.filter(model.namespace != "system")
        return query

    def _archived_tasks_query(
        self,
        db: Session,
        model: type,
        *,
        user_id: int,
        client_origin: str | None,
    ):
        query = db.query(model).filter(
            model.user_id == user_id,
            model.kind == "Task",
            model.namespace != "system",
            model.is_active == TaskResource.STATE_ARCHIVED,
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query

    def _archivable_active_tasks_query(
        self,
        db: Session,
        model: type,
        *,
        user_id: int,
        scope: str,
        project_id: int | None,
        client_origin: str | None,
    ):
        query = db.query(model).filter(
            model.user_id == user_id,
            model.kind == "Task",
            model.namespace != "system",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        if scope == "standalone":
            query = query.filter(model.project_id == 0)
        elif scope == "project":
            query = query.filter(model.project_id > 0)
        elif scope == "project_id":
            query = query.filter(model.project_id == project_id)
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query

    def _owned_active_task_rows(
        self,
        db: Session,
        *,
        user_id: int,
        exclude_system_namespace: bool = False,
        is_group_chat: bool | None = None,
        client_origin: str | None = None,
        project_id: int | None = None,
    ) -> list[TaskResource]:
        legacy_tasks = self._owned_active_task_query(
            db,
            TaskResource,
            user_id=user_id,
            exclude_system_namespace=exclude_system_namespace,
            is_group_chat=is_group_chat,
            client_origin=client_origin,
            project_id=project_id,
        ).all()
        legacy_tasks = self._exclude_migrated_legacy_index_rows(db, legacy_tasks)
        model = task_model_for_user(user_id)
        shard_tasks = self._owned_active_task_query(
            db,
            model,
            user_id=user_id,
            exclude_system_namespace=exclude_system_namespace,
            is_group_chat=is_group_chat,
            client_origin=client_origin,
            project_id=project_id,
        ).all()
        return self._deduplicate_tasks_by_id([*shard_tasks, *legacy_tasks])

    def _owned_active_task_page_and_total(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int,
        limit: int,
        exclude_system_namespace: bool = False,
        is_group_chat: bool | None = None,
        client_origin: str | None = None,
        project_id: int | None = None,
    ) -> tuple[list[Any], int]:
        if client_origin and project_id is not None and is_group_chat is not None:
            return self._candidate_scanned_owned_active_task_page_and_total(
                db,
                user_id=user_id,
                skip=skip,
                limit=limit,
                exclude_system_namespace=exclude_system_namespace,
                is_group_chat=is_group_chat,
                client_origin=client_origin,
                project_id=project_id,
            )

        page_limit = skip + limit
        shard_model = task_model_for_user(user_id)
        legacy_query = self._owned_active_task_query(
            db,
            TaskResource,
            user_id=user_id,
            exclude_system_namespace=exclude_system_namespace,
            is_group_chat=is_group_chat,
            client_origin=client_origin,
            project_id=project_id,
        )
        shard_query = self._owned_active_task_query(
            db,
            shard_model,
            user_id=user_id,
            exclude_system_namespace=exclude_system_namespace,
            is_group_chat=is_group_chat,
            client_origin=client_origin,
            project_id=project_id,
        )

        legacy_total = self._count_query_rows(legacy_query)
        shard_total = self._count_query_rows(shard_query)
        duplicate_total = self._count_migrated_legacy_index_rows(
            db=db,
            shard_model=shard_model,
            legacy_query=legacy_query,
            legacy_model=TaskResource,
        )

        legacy_rows = self._ordered_limited_rows(
            legacy_query, TaskResource, limit=page_limit + duplicate_total
        )
        legacy_rows = self._exclude_migrated_legacy_index_rows(db, legacy_rows)
        shard_rows = self._ordered_limited_rows(
            shard_query, shard_model, limit=page_limit
        )

        rows = self._deduplicate_tasks_by_id([*shard_rows, *legacy_rows])
        ordered_rows = self._order_tasks_by_created_at_desc(rows)
        page_rows = ordered_rows[skip : skip + limit]
        return page_rows, legacy_total + shard_total - duplicate_total

    def _candidate_scanned_owned_active_task_page_and_total(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int,
        limit: int,
        exclude_system_namespace: bool,
        is_group_chat: bool,
        client_origin: str,
        project_id: int,
    ) -> tuple[list[Any], int]:
        legacy_rows = self._owned_active_task_candidate_rows(
            db,
            TaskResource,
            user_id=user_id,
            client_origin=client_origin,
            project_id=project_id,
        )
        legacy_rows = self._exclude_migrated_legacy_index_rows(db, legacy_rows)
        shard_rows = self._owned_active_task_candidate_rows(
            db,
            task_model_for_user(user_id),
            user_id=user_id,
            client_origin=client_origin,
            project_id=project_id,
        )
        filtered_rows = [
            row
            for row in [*shard_rows, *legacy_rows]
            if row.kind == "Task"
            and row.is_group_chat == is_group_chat
            and (not exclude_system_namespace or row.namespace != "system")
        ]
        ordered_rows = self._order_tasks_by_created_at_desc(
            self._deduplicate_tasks_by_id(filtered_rows)
        )
        return ordered_rows[skip : skip + limit], len(ordered_rows)

    def _owned_active_task_candidate_rows(
        self,
        db: Session,
        model: type,
        *,
        user_id: int,
        client_origin: str,
        project_id: int,
    ) -> list:
        return (
            db.query(
                model.id,
                model.user_id,
                model.created_at,
                model.kind,
                model.namespace,
                model.is_group_chat,
            )
            .filter(
                model.user_id == user_id,
                model.is_active == TaskResource.STATE_ACTIVE,
                model.client_origin == client_origin,
                model.project_id == project_id,
            )
            .all()
        )

    def _count_query_rows(self, query) -> int:
        return int(query.order_by(None).with_entities(func.count()).scalar() or 0)

    def _count_migrated_legacy_index_rows(
        self,
        *,
        db: Session,
        shard_model: type,
        legacy_query,
        legacy_model: type,
    ) -> int:
        legacy_ids = (
            legacy_query.order_by(None).with_entities(legacy_model.id).subquery()
        )
        return int(
            db.query(shard_model.id)
            .filter(shard_model.id.in_(select(legacy_ids.c.id)))
            .with_entities(func.count())
            .scalar()
            or 0
        )

    def _ordered_limited_rows(self, query, model: type, *, limit: int) -> list:
        return (
            query.with_entities(model.id, model.user_id, model.created_at)
            .order_by(model.created_at.desc(), model.id.desc())
            .limit(limit)
            .all()
        )

    def _owned_active_task_query(
        self,
        db: Session,
        model: type,
        *,
        user_id: int,
        exclude_system_namespace: bool,
        is_group_chat: bool | None,
        client_origin: str | None,
        project_id: int | None = None,
    ):
        query = db.query(model).filter(
            model.user_id == user_id,
            model.kind == "Task",
            model.is_active == TaskResource.STATE_ACTIVE,
        )
        if exclude_system_namespace:
            query = query.filter(model.namespace != "system")
        if is_group_chat is not None:
            query = query.filter(model.is_group_chat == is_group_chat)
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        if project_id is not None:
            query = query.filter(model.project_id == project_id)
        return query

    def _member_task_rows(self, db: Session, *, user_id: int) -> list[TaskResource]:
        member_task_ids = self._member_task_ids(db, user_id=user_id)
        return self.list_by_ids(db, task_ids=member_task_ids)

    def _member_shard_task_rows(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]:
        return self._list_shard_tasks_by_ids(
            db, task_ids=self._member_task_ids(db, user_id=user_id)
        )

    def _list_shard_tasks_by_ids(
        self, db: Session, *, task_ids: Sequence[int]
    ) -> list[TaskResource]:
        if not task_ids:
            return []

        new_ids_by_model: dict[type, list[int]] = defaultdict(list)
        legacy_ids: list[int] = []
        for task_id in task_ids:
            if is_new_task_id(task_id):
                new_ids_by_model[task_model_for_task_id(task_id)].append(task_id)
            else:
                legacy_ids.append(task_id)

        tasks: list[TaskResource] = []
        for model, model_task_ids in new_ids_by_model.items():
            tasks.extend(db.query(model).filter(model.id.in_(model_task_ids)).all())
        if legacy_ids:
            for slot in range(SHARD_COUNT):
                model = task_model_for_user(slot)
                tasks.extend(db.query(model).filter(model.id.in_(legacy_ids)).all())
        return tasks

    def _owned_active_shard_task_page_and_total(
        self,
        db: Session,
        *,
        user_id: int,
        limit: int,
        exclude_system_namespace: bool = False,
    ) -> tuple[list[TaskResource], int]:
        model = task_model_for_user(user_id)
        query = self._owned_active_task_query(
            db,
            model,
            user_id=user_id,
            exclude_system_namespace=exclude_system_namespace,
            is_group_chat=None,
            client_origin=None,
        )
        total = self._count_query_rows(query)
        tasks = (
            query.order_by(model.created_at.desc(), model.id.desc()).limit(limit).all()
        )
        return tasks, total

    def _member_task_ids(self, db: Session, *, user_id: int) -> list[int]:
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
        return [row[0] for row in rows]

    def _is_active_regular_task(
        self,
        task: TaskResource,
        *,
        exclude_system_namespace: bool = False,
        is_group_chat: bool | None = None,
    ) -> bool:
        if task.kind != "Task":
            return False
        if task.is_active != TaskResource.STATE_ACTIVE:
            return False
        if exclude_system_namespace and task.namespace == "system":
            return False
        if is_group_chat is not None and task.is_group_chat != is_group_chat:
            return False
        return True

    def _deduplicate_tasks_by_id(
        self, tasks: Sequence[TaskResource]
    ) -> list[TaskResource]:
        tasks_by_id: dict[int, TaskResource] = {}
        for task in tasks:
            tasks_by_id.setdefault(task.id, task)
        return list(tasks_by_id.values())

    def _deduplicate_task_ids(self, task_ids: Sequence[int]) -> list[int]:
        seen: set[int] = set()
        unique_task_ids: list[int] = []
        for task_id in task_ids:
            if task_id in seen:
                continue
            seen.add(task_id)
            unique_task_ids.append(task_id)
        return unique_task_ids

    def _order_tasks_by_created_at_desc(
        self, tasks: Sequence[TaskResource]
    ) -> list[TaskResource]:
        return sorted(
            tasks,
            key=lambda task: (task.created_at, task.id),
            reverse=True,
        )

    def _page_task_ids(
        self, tasks: Sequence[TaskResource], *, skip: int, limit: int
    ) -> list[int]:
        return [task.id for task in tasks[skip : skip + limit]]

    def _order_by_input_ids(
        self, tasks: Sequence[TaskResource], input_ids: Sequence[int]
    ) -> list[TaskResource]:
        tasks_by_id: dict[int, TaskResource] = {}
        for task in tasks:
            tasks_by_id.setdefault(task.id, task)
        return [tasks_by_id[task_id] for task_id in input_ids if task_id in tasks_by_id]

    def _order_workspaces_by_refs(
        self, workspaces: Sequence[TaskResource], refs: Sequence
    ) -> list[TaskResource]:
        workspaces_by_ref = {
            (workspace.user_id, workspace.namespace, workspace.name): workspace
            for workspace in workspaces
        }
        return [
            workspaces_by_ref[(ref.user_id, ref.namespace, ref.name)]
            for ref in refs
            if (ref.user_id, ref.namespace, ref.name) in workspaces_by_ref
        ]

    def _clear_project_for_model(
        self,
        db: Session,
        model: type,
        *,
        project_id: int,
        user_id: int,
        client_origin: str | None,
    ) -> int:
        query = db.query(model).filter(
            model.project_id == project_id,
            model.user_id == user_id,
        )
        if client_origin:
            query = query.filter(model.client_origin == client_origin)
        return query.update({model.project_id: 0}, synchronize_session="fetch")

    def _order_tasks(
        self,
        tasks: list[TaskResource],
        *,
        order_by_id_desc: bool,
        order_by_updated_at_desc: bool,
    ) -> list[TaskResource]:
        if order_by_id_desc and order_by_updated_at_desc:
            return sorted(
                tasks,
                key=lambda task: (task.id, task.updated_at),
                reverse=True,
            )
        if order_by_id_desc:
            return sorted(tasks, key=lambda task: task.id, reverse=True)
        if order_by_updated_at_desc:
            return sorted(tasks, key=lambda task: task.updated_at, reverse=True)
        return tasks

    def _is_json_deleted(self, task: TaskResource) -> bool:
        payload = task.json if isinstance(task.json, dict) else {}
        status = payload.get("status") or {}
        if not isinstance(status, dict):
            return False
        return status.get("status") == "DELETE"
