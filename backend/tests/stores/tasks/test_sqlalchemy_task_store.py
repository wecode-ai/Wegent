# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.interfaces import TaskStore, WorkspaceRefLookup
from app.stores.tasks.sqlalchemy_access_store import SqlAlchemyTaskAccessStore
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore


def test_task_store_protocol_declares_all_public_implementation_methods() -> None:
    implementation_methods = {
        name
        for name, value in vars(SqlAlchemyTaskStore).items()
        if callable(value) and not name.startswith("_")
    }
    protocol_methods = {
        name
        for name, value in vars(TaskStore).items()
        if callable(value) and not name.startswith("_")
    }

    assert implementation_methods <= protocol_methods


def _task(
    *,
    task_id: int,
    user_id: int,
    kind: str = "Task",
    namespace: str = "default",
    is_active: int = TaskResource.STATE_ACTIVE,
    client_origin: str = CLIENT_ORIGIN_FRONTEND,
) -> TaskResource:
    now = datetime.now() + timedelta(seconds=task_id)
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind=kind,
        name=f"{kind.lower()}-{task_id}",
        namespace=namespace,
        json={
            "kind": kind,
            "metadata": {"name": f"{kind.lower()}-{task_id}", "namespace": namespace},
            "spec": {"workspaceRef": {"name": "workspace-1", "namespace": "default"}},
            "status": {"status": "PENDING"},
        },
        is_active=is_active,
        client_origin=client_origin,
        created_at=now,
        updated_at=now,
    )


def test_get_active_task_filters_kind_state_and_client_origin(
    test_db: Session,
) -> None:
    store = SqlAlchemyTaskStore()
    matching = _task(task_id=1, user_id=10, client_origin=CLIENT_ORIGIN_FRONTEND)
    wrong_origin = _task(task_id=2, user_id=10, client_origin=CLIENT_ORIGIN_WEWORK)
    wrong_kind = _task(task_id=3, user_id=10, kind="Workspace")
    deleted = _task(task_id=4, user_id=10, is_active=TaskResource.STATE_DELETED)
    system = _task(task_id=5, user_id=10, namespace="system")
    test_db.add_all([matching, wrong_origin, wrong_kind, deleted, system])
    test_db.commit()

    assert (
        store.get_active_task(
            test_db,
            task_id=matching.id,
            client_origin=CLIENT_ORIGIN_FRONTEND,
        )
        == matching
    )
    assert (
        store.get_active_task(
            test_db,
            task_id=wrong_origin.id,
            client_origin=CLIENT_ORIGIN_FRONTEND,
        )
        is None
    )
    assert store.get_active_task(test_db, task_id=wrong_kind.id) is None
    assert store.get_active_task(test_db, task_id=deleted.id) is None
    assert store.get_active_task(test_db, task_id=system.id) == system


def test_task_lookup_methods_filter_optional_owner_user_id(test_db: Session) -> None:
    store = SqlAlchemyTaskStore()
    task = _task(task_id=20, user_id=10)
    other_task = _task(task_id=21, user_id=20)
    test_db.add_all([task, other_task])
    test_db.commit()

    assert store.get_by_id(test_db, task_id=task.id, owner_user_id=10) == task
    assert store.get_by_id(test_db, task_id=task.id, owner_user_id=20) is None
    assert store.get_active_task(test_db, task_id=task.id, owner_user_id=10) == task
    assert store.get_active_task(test_db, task_id=task.id, owner_user_id=20) is None
    assert store.list_by_ids(
        test_db,
        task_ids=[task.id, other_task.id],
        owner_user_id=10,
    ) == [task]


def test_get_task_by_states_filters_kind_state_and_optional_user(
    test_db: Session,
) -> None:
    store = SqlAlchemyTaskStore()
    active = _task(task_id=6, user_id=10)
    subscription = _task(
        task_id=7,
        user_id=10,
        is_active=TaskResource.STATE_SUBSCRIPTION,
    )
    deleted = _task(task_id=8, user_id=10, is_active=TaskResource.STATE_DELETED)
    wrong_user = _task(task_id=9, user_id=20)
    test_db.add_all([active, subscription, deleted, wrong_user])
    test_db.commit()

    assert (
        store.get_task_by_states(
            test_db,
            task_id=active.id,
            states=TaskResource.is_active_query(),
            user_id=10,
        )
        == active
    )
    assert (
        store.get_task_by_states(
            test_db,
            task_id=subscription.id,
            states=TaskResource.is_active_query(),
            user_id=10,
        )
        == subscription
    )
    assert (
        store.get_task_by_states(
            test_db,
            task_id=deleted.id,
            states=TaskResource.is_active_query(),
            user_id=10,
        )
        is None
    )
    assert (
        store.get_task_by_states(
            test_db,
            task_id=wrong_user.id,
            states=TaskResource.is_active_query(),
            user_id=10,
        )
        is None
    )


def test_task_store_project_and_workspace_helpers(test_db: Session) -> None:
    store = SqlAlchemyTaskStore()
    task = _task(task_id=101, user_id=10)
    task.project_id = 500
    workspace = _task(task_id=102, user_id=10, kind="Workspace")
    other_workspace = _task(task_id=103, user_id=20, kind="Workspace")
    inactive_workspace = _task(
        task_id=104,
        user_id=10,
        kind="Workspace",
        is_active=TaskResource.STATE_DELETED,
    )
    test_db.add_all([task, workspace, other_workspace, inactive_workspace])
    test_db.commit()

    assert (
        store.get_active_workspace_by_id(test_db, workspace_id=workspace.id)
        == workspace
    )
    assert (
        store.get_owned_active_workspace_by_id(
            test_db,
            workspace_id=workspace.id,
            user_id=10,
        )
        == workspace
    )
    assert (
        store.get_owned_active_workspace_by_id(
            test_db,
            workspace_id=other_workspace.id,
            user_id=10,
        )
        is None
    )
    assert store.list_active_workspaces_by_ids(
        test_db,
        workspace_ids=[workspace.id, inactive_workspace.id],
    ) == [workspace]
    assert store.count_active_project_tasks(test_db, project_id=500) == 1
    assert store.list_active_project_tasks(test_db, project_id=500) == [task]


def test_create_task_resource_persists_task_without_preallocated_id(
    test_db: Session,
) -> None:
    store = SqlAlchemyTaskStore()

    task = store.create_task_resource(
        test_db,
        user_id=10,
        name="copied-task",
        namespace="default",
        payload={"kind": "Task", "metadata": {"name": "copied-task"}},
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    test_db.commit()

    assert task.id is not None
    assert task.kind == "Task"
    assert task.name == "copied-task"
    assert task.user_id == 10


def test_list_accessible_active_tasks_for_user_includes_owned_and_member(
    test_db: Session,
) -> None:
    store = SqlAlchemyTaskStore()
    owned = _task(task_id=111, user_id=10)
    joined = _task(task_id=112, user_id=20)
    copied_joined = _task(task_id=114, user_id=20)
    deleted_joined = _task(
        task_id=113,
        user_id=20,
        is_active=TaskResource.STATE_DELETED,
    )
    test_db.add_all([owned, joined, copied_joined, deleted_joined])
    test_db.add_all(
        [
            ResourceMember(
                resource_type=ResourceType.TASK,
                resource_id=joined.id,
                entity_type="user",
                entity_id="10",
                user_id=10,
                role=ResourceRole.Reporter.value,
                status=MemberStatus.APPROVED,
                copied_resource_id=0,
            ),
            ResourceMember(
                resource_type=ResourceType.TASK,
                resource_id=deleted_joined.id,
                entity_type="user",
                entity_id="10",
                user_id=10,
                role=ResourceRole.Reporter.value,
                status=MemberStatus.APPROVED,
                copied_resource_id=0,
            ),
            ResourceMember(
                resource_type=ResourceType.TASK,
                resource_id=copied_joined.id,
                entity_type="user",
                entity_id="10",
                user_id=10,
                role=ResourceRole.Reporter.value,
                status=MemberStatus.APPROVED,
                copied_resource_id=999,
            ),
        ]
    )
    test_db.commit()

    tasks = store.list_accessible_active_tasks_for_user(test_db, user_id=10)

    assert {task.id for task in tasks} == {owned.id, joined.id, copied_joined.id}


def test_task_access_store_rejects_stale_member_without_active_task(
    test_db: Session,
) -> None:
    store = SqlAlchemyTaskAccessStore()
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=404,
            entity_type="user",
            entity_id="10",
            user_id=10,
            role=ResourceRole.Reporter.value,
            status=MemberStatus.APPROVED,
            copied_resource_id=0,
        )
    )
    test_db.commit()

    assert store.is_member(test_db, task_id=404, user_id=10) is False


def test_list_personal_task_ids_filters_client_origin(test_db: Session) -> None:
    store = SqlAlchemyTaskStore()
    frontend_task = _task(
        task_id=11,
        user_id=20,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    wework_task = _task(
        task_id=12,
        user_id=20,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )
    group_task = _task(task_id=13, user_id=20, client_origin=CLIENT_ORIGIN_FRONTEND)
    group_task.is_group_chat = True
    test_db.add_all([frontend_task, wework_task, group_task])
    test_db.commit()

    task_ids, total = store.list_personal_task_ids(
        test_db,
        user_id=20,
        skip=0,
        limit=10,
        extra_limit=0,
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )

    assert task_ids == [frontend_task.id]
    assert total == 1


def test_group_task_ids_include_owned_and_joined_tasks(test_db: Session) -> None:
    store = SqlAlchemyTaskStore()
    owned_group = _task(task_id=31, user_id=20)
    owned_group.is_group_chat = True
    joined_group = _task(task_id=32, user_id=30)
    deleted_joined = _task(
        task_id=33,
        user_id=30,
        is_active=TaskResource.STATE_DELETED,
    )
    test_db.add_all([owned_group, joined_group, deleted_joined])
    test_db.add_all(
        [
            ResourceMember(
                resource_type=ResourceType.TASK,
                resource_id=joined_group.id,
                entity_type="user",
                entity_id="20",
                user_id=20,
                role=ResourceRole.Maintainer.value,
                status=MemberStatus.APPROVED,
                copied_resource_id=0,
            ),
            ResourceMember(
                resource_type=ResourceType.TASK,
                resource_id=deleted_joined.id,
                entity_type="user",
                entity_id="20",
                user_id=20,
                role=ResourceRole.Maintainer.value,
                status=MemberStatus.APPROVED,
                copied_resource_id=0,
            ),
        ]
    )
    test_db.commit()

    task_ids = store.list_group_task_ids_for_accessible_user(test_db, user_id=20)

    assert task_ids == {owned_group.id, joined_group.id}


def test_list_workspaces_by_refs_uses_named_lookup_and_filters_inactive(
    test_db: Session,
) -> None:
    store = SqlAlchemyTaskStore()
    active_workspace = _task(
        task_id=21,
        user_id=30,
        kind="Workspace",
        is_active=TaskResource.STATE_ACTIVE,
    )
    active_workspace.name = "workspace-active"
    deleted_workspace = _task(
        task_id=22,
        user_id=30,
        kind="Workspace",
        is_active=TaskResource.STATE_DELETED,
    )
    deleted_workspace.name = "workspace-deleted"
    test_db.add_all([active_workspace, deleted_workspace])
    test_db.commit()

    workspaces = store.list_workspaces_by_refs(
        test_db,
        refs=[
            WorkspaceRefLookup(
                user_id=30,
                namespace="default",
                name="workspace-active",
            ),
            WorkspaceRefLookup(
                user_id=30,
                namespace="default",
                name="workspace-deleted",
            ),
        ],
    )

    assert [workspace.id for workspace in workspaces] == [active_workspace.id]
