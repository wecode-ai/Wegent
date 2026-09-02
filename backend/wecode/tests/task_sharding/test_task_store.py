from datetime import datetime, timedelta

import pytest
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.stores.tasks.interfaces import WorkspaceRefLookup
from app.stores.tasks.sqlalchemy_task_store import SqlAlchemyTaskStore
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.task_store import (
    ShardedTaskStore,
    TaskIdAllocationError,
)
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    decode_user_scoped_id,
    encode_user_scoped_id,
    uid_from_id,
)

pytestmark = pytest.mark.unit


class RecordingGlobalIdAllocator:
    def __init__(self, task_ids: list[int]):
        self.task_ids = list(task_ids)
        self.task_calls = 0

    def allocate_task_id(self, user_id: int = 0) -> int:
        self.task_calls += 1
        return self.task_ids.pop(0)

    def allocate_subtask_id(self) -> int:
        raise AssertionError("subtask id allocation is not expected")


@pytest.fixture(scope="module", autouse=True)
def create_task_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        model = task_model_for_user(uid)
        model.__table__.create(bind=test_engine, checkfirst=True)


@pytest.fixture
def fixed_clock():
    # No time-based ID generation in the new format; fixture kept for test signature compatibility.
    return None


def count_legacy_tasks(test_db) -> int:
    return test_db.query(TaskResource).count()


def count_shard_rows(test_db, task_id_value: int) -> int:
    model = task_model_for_task_id(task_id_value)
    return test_db.query(model).filter(model.id == task_id_value).count()


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(user_id & 0xFFFF, sequence)


def add_shard_resource(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    kind: str = "Task",
    namespace: str = "default",
    state: int = TaskResource.STATE_ACTIVE,
    client_origin: str = "frontend",
    name: str | None = None,
    payload: dict | None = None,
    project_id: int = 0,
    is_group_chat: bool = False,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
):
    model = task_model_for_task_id(task_id_value)
    resource = model(
        id=task_id_value,
        user_id=user_id,
        kind=kind,
        name=name or f"{kind.lower()}-{task_id_value}",
        namespace=namespace,
        json=payload or {"kind": kind},
        is_active=state,
        client_origin=client_origin,
        project_id=project_id,
        is_group_chat=is_group_chat,
    )
    if created_at is not None:
        resource.created_at = created_at
    if updated_at is not None:
        resource.updated_at = updated_at
    test_db.add(resource)
    test_db.flush()
    return resource


def add_legacy_resource(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    kind: str = "Task",
    namespace: str = "default",
    state: int = TaskResource.STATE_ACTIVE,
    client_origin: str = "frontend",
    name: str | None = None,
    payload: dict | None = None,
    project_id: int = 0,
    is_group_chat: bool = False,
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
):
    resource = TaskResource(
        id=task_id_value,
        user_id=user_id,
        kind=kind,
        name=name or f"{kind.lower()}-{task_id_value}",
        namespace=namespace,
        json=payload or {"kind": kind},
        is_active=state,
        client_origin=client_origin,
        project_id=project_id,
        is_group_chat=is_group_chat,
    )
    if created_at is not None:
        resource.created_at = created_at
    if updated_at is not None:
        resource.updated_at = updated_at
    test_db.add(resource)
    test_db.flush()
    return resource


def add_migrated_legacy_resource(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    kind: str = "Task",
    state: int = TaskResource.STATE_ACTIVE,
    name: str = "migrated-shard",
    project_id: int = 0,
    updated_at: datetime | None = None,
    created_at: datetime | None = None,
):
    index_row = add_legacy_resource(
        test_db,
        task_id_value=task_id_value,
        user_id=user_id,
        kind=kind,
        state=state,
        name=f"legacy-index-{task_id_value}",
        project_id=project_id,
        updated_at=updated_at,
        created_at=created_at,
    )
    model = task_model_for_user(user_id)
    shard_row = model(
        id=task_id_value,
        user_id=user_id,
        kind=kind,
        name=name,
        namespace="default",
        json={"kind": kind, "source": "shard"},
        is_active=state,
        client_origin="frontend",
        project_id=project_id,
        is_group_chat=False,
    )
    if updated_at is not None:
        shard_row.updated_at = updated_at
    if created_at is not None:
        shard_row.created_at = created_at
    test_db.add(shard_row)
    test_db.flush()
    return index_row, shard_row


def add_resource_member(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    status: MemberStatus = MemberStatus.APPROVED,
    copied_resource_id: int = 0,
):
    member = ResourceMember(
        resource_type=ResourceType.TASK,
        resource_id=task_id_value,
        entity_type="user",
        entity_id=str(user_id),
        user_id=user_id,
        role=ResourceRole.Reporter.value,
        status=status,
        copied_resource_id=copied_resource_id,
    )
    test_db.add(member)
    test_db.flush()
    return member


def test_get_by_id_reads_migrated_legacy_id_from_owner_shard(test_db):
    _, shard_row = add_migrated_legacy_resource(
        test_db,
        task_id_value=91,
        user_id=1091,
    )
    store = ShardedTaskStore()

    task = store.get_by_id(test_db, task_id=91)

    assert task.id == shard_row.id
    assert task.name == "migrated-shard"


def test_list_by_ids_prefers_migrated_legacy_id_shard_row(test_db):
    add_migrated_legacy_resource(test_db, task_id_value=92, user_id=1092)
    store = ShardedTaskStore()

    tasks = store.list_by_ids(test_db, task_ids=[92])

    assert [task.name for task in tasks] == ["migrated-shard"]


def test_list_regular_active_tasks_deduplicates_migrated_legacy_rows(test_db):
    add_migrated_legacy_resource(test_db, task_id_value=93, user_id=1093)
    store = ShardedTaskStore()

    tasks = store.list_regular_active_tasks(
        test_db,
        user_id=1093,
        order_by_id_desc=True,
    )

    assert [task.id for task in tasks] == [93]
    assert tasks[0].name == "migrated-shard"


def test_list_recent_owner_only_tasks_reads_only_current_user_shard(test_db):
    user_id = 1096
    now = datetime(2026, 8, 5, 12, 0, 0)
    older = add_shard_resource(
        test_db,
        task_id_value=new_task_id(user_id, 1),
        user_id=user_id,
        name="older",
        updated_at=now,
    )
    newer = add_shard_resource(
        test_db,
        task_id_value=new_task_id(user_id, 2),
        user_id=user_id,
        name="newer",
        updated_at=now + timedelta(minutes=1),
    )
    add_legacy_resource(
        test_db,
        task_id_value=96,
        user_id=user_id,
        name="legacy-newest",
        updated_at=now + timedelta(minutes=2),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(user_id, 3),
        user_id=user_id,
        name="group-chat",
        is_group_chat=True,
        updated_at=now + timedelta(minutes=3),
    )
    store = ShardedTaskStore()

    tasks = store.list_recent_owner_only_tasks(
        test_db,
        user_id=user_id,
        limit=50,
    )

    assert [task.id for task in tasks] == [newer.id, older.id]


def test_owned_task_ids_deduplicate_migrated_legacy_rows(test_db):
    add_migrated_legacy_resource(test_db, task_id_value=94, user_id=1094)
    store = ShardedTaskStore()

    task_ids, total = store.list_owned_task_ids(
        test_db,
        user_id=1094,
        skip=0,
        limit=10,
        extra_limit=0,
    )
    active_tasks = store.list_active_tasks_for_user(test_db, user_id=1094)

    assert task_ids == [94]
    assert total == 1
    assert [task.name for task in active_tasks] == ["migrated-shard"]


def test_personal_task_ids_candidate_scan_deduplicates_migrated_legacy_rows(test_db):
    add_migrated_legacy_resource(test_db, task_id_value=95, user_id=1095)
    store = ShardedTaskStore()

    task_ids, total = store.list_personal_task_ids(
        test_db,
        user_id=1095,
        skip=0,
        limit=10,
        extra_limit=0,
        client_origin="frontend",
    )

    assert task_ids == [95]
    assert total == 1


def test_migrated_legacy_index_row_is_not_source_of_truth(test_db):
    add_legacy_resource(
        test_db,
        task_id_value=98,
        user_id=1098,
        state=TaskResource.STATE_ACTIVE,
        name="stale-active-index",
    )
    model = task_model_for_user(1098)
    shard_row = model(
        id=98,
        user_id=1098,
        kind="Task",
        name="archived-shard-source",
        namespace="default",
        json={"kind": "Task", "source": "shard"},
        is_active=TaskResource.STATE_ARCHIVED,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    test_db.add(shard_row)
    test_db.flush()
    store = ShardedTaskStore()

    active_tasks = store.list_regular_active_tasks(test_db, user_id=1098)
    owned_ids, owned_total = store.list_owned_task_ids(
        test_db,
        user_id=1098,
        skip=0,
        limit=10,
        extra_limit=0,
    )
    archived_tasks, archived_total = store.list_archived_tasks(test_db, user_id=1098)

    assert active_tasks == []
    assert owned_ids == []
    assert owned_total == 0
    assert [task.name for task in archived_tasks] == ["archived-shard-source"]
    assert archived_total == 1


def test_workspace_lists_deduplicate_migrated_legacy_rows(test_db):
    add_migrated_legacy_resource(
        test_db,
        task_id_value=95,
        user_id=1095,
        kind="Workspace",
    )
    store = ShardedTaskStore()

    by_user = store.list_active_workspaces_by_user(test_db, user_id=1095)
    by_ids = store.list_active_workspaces_by_ids(test_db, workspace_ids=[95])

    assert [workspace.name for workspace in by_user] == ["migrated-shard"]
    assert [workspace.name for workspace in by_ids] == ["migrated-shard"]


def test_archived_and_project_lists_deduplicate_migrated_legacy_rows(test_db):
    updated_at = datetime(2026, 6, 12, 9, 0, 0)
    add_migrated_legacy_resource(
        test_db,
        task_id_value=96,
        user_id=1096,
        state=TaskResource.STATE_ARCHIVED,
        name="archived-shard",
        updated_at=updated_at,
    )
    add_migrated_legacy_resource(
        test_db,
        task_id_value=97,
        user_id=1096,
        project_id=42,
        name="project-shard",
        updated_at=updated_at,
    )
    store = ShardedTaskStore()

    archived, archived_total = store.list_archived_tasks(
        test_db,
        user_id=1096,
    )
    archived_ids = store.list_archived_task_ids(test_db, user_id=1096)
    project_tasks = store.list_active_project_tasks(
        test_db,
        project_id=42,
        owner_user_id=1096,
    )
    project_count = store.count_active_project_tasks(
        test_db,
        project_id=42,
        owner_user_id=1096,
    )

    assert [task.name for task in archived] == ["archived-shard"]
    assert archived_total == 1
    assert archived_ids == [96]
    assert [task.name for task in project_tasks] == ["project-shard"]
    assert project_count == 1


def test_create_placeholder_task_id_allocates_new_id_without_legacy_row(
    test_db,
    fixed_clock,
):
    allocated_id = encode_user_scoped_id(17, 7)
    allocator = RecordingGlobalIdAllocator(task_ids=[allocated_id])
    store = ShardedTaskStore(global_id_allocator=allocator)

    result = store.create_placeholder_task_id(test_db, user_id=17)

    assert allocator.task_calls == 1
    assert result == allocated_id
    assert uid_from_id(allocated_id) == 17
    model = task_model_for_task_id(allocated_id)
    placeholder = test_db.query(model).filter(model.id == allocated_id).one()
    assert placeholder.kind == "Placeholder"
    assert placeholder.user_id == 17
    assert count_legacy_tasks(test_db) == 0


def test_create_pending_task_shell_writes_shard_only(test_db, fixed_clock):
    allocated_id = encode_user_scoped_id(18, 1)
    store = ShardedTaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([allocated_id])
    )

    task = store.create_pending_task_shell(
        test_db,
        user_id=18,
        client_origin="frontend",
        is_group_chat=True,
        project_id=12,
    )
    test_db.flush()

    assert uid_from_id(task.id) == 18
    assert count_shard_rows(test_db, task.id) == 1
    assert count_legacy_tasks(test_db) == 0
    assert task.kind == "Task"
    assert task.client_origin == "frontend"
    assert task.is_group_chat is True
    assert task.project_id == 12


def test_create_workspace_writes_shard_only(test_db, fixed_clock):
    allocated_id = encode_user_scoped_id(19, 2)
    store = ShardedTaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([allocated_id])
    )

    workspace = store.create_workspace(
        test_db,
        user_id=19,
        name="workspace-a",
        namespace="default",
        payload={"kind": "Workspace"},
        client_origin="frontend",
    )
    test_db.flush()

    assert uid_from_id(workspace.id) == 19
    assert count_shard_rows(test_db, workspace.id) == 1
    assert count_legacy_tasks(test_db) == 0
    assert workspace.kind == "Workspace"


def test_create_pending_task_shell_with_workspace_allocates_pair_in_one_batch(
    test_db,
    fixed_clock,
):
    task_id_val = encode_user_scoped_id(19, 5)
    workspace_id_val = encode_user_scoped_id(19, 6)
    allocator = RecordingGlobalIdAllocator(task_ids=[task_id_val, workspace_id_val])
    store = ShardedTaskStore(global_id_allocator=allocator)

    task, workspace = store.create_pending_task_shell_with_workspace(
        test_db,
        user_id=19,
        client_origin="frontend",
        workspace_factory=lambda task_id_value: (
            f"workspace-{task_id_value}",
            "default",
            {
                "kind": "Workspace",
                "metadata": {
                    "name": f"workspace-{task_id_value}",
                    "namespace": "default",
                },
            },
        ),
        is_group_chat=True,
        project_id=12,
    )
    test_db.flush()

    assert allocator.task_calls == 2
    assert decode_user_scoped_id(task.id)[2] == 5
    assert decode_user_scoped_id(workspace.id)[2] == 6
    assert task.kind == "Task"
    assert workspace.kind == "Workspace"
    assert workspace.name == f"workspace-{task.id}"
    assert count_shard_rows(test_db, task.id) == 1
    assert count_shard_rows(test_db, workspace.id) == 1
    assert count_legacy_tasks(test_db) == 0


def test_create_task_routes_new_task_id_to_shard(test_db, fixed_clock):
    new_id = encode_user_scoped_id(20, 3)
    store = ShardedTaskStore(global_id_allocator=RecordingGlobalIdAllocator([new_id]))

    task = store.create_task(
        test_db,
        task_id=new_id,
        user_id=20,
        name="task-a",
        namespace="default",
        payload={"kind": "Task"},
        client_origin="frontend",
    )
    test_db.flush()

    assert task.id == new_id
    assert count_shard_rows(test_db, new_id) == 1
    assert count_legacy_tasks(test_db) == 0


def test_create_task_resource_and_kind_resource_write_shard_only(
    test_db,
    fixed_clock,
):
    task_allocated_id = encode_user_scoped_id(25, 41)
    workspace_allocated_id = encode_user_scoped_id(25, 42)
    store = ShardedTaskStore(
        global_id_allocator=RecordingGlobalIdAllocator(
            [task_allocated_id, workspace_allocated_id]
        )
    )

    task = store.create_task_resource(
        test_db,
        user_id=25,
        name="created-task",
        namespace="default",
        payload={"kind": "Task"},
        client_origin="frontend",
        project_id=9,
        is_group_chat=True,
    )
    workspace = store.create_kind_resource(
        test_db,
        user_id=25,
        kind="Workspace",
        name="created-workspace",
        namespace="default",
        payload={"kind": "Workspace"},
    )
    test_db.flush()

    assert uid_from_id(task.id) == 25
    assert task.project_id == 9
    assert task.is_group_chat is True
    assert task.client_origin == "frontend"
    assert uid_from_id(workspace.id) == 25
    assert count_shard_rows(test_db, task.id) == 1
    assert count_shard_rows(test_db, workspace.id) == 1
    assert count_legacy_tasks(test_db) == 0


def test_get_by_id_uses_route_for_redis_style_id(test_db):
    store = ShardedTaskStore()
    task_id_value = 102
    add_legacy_resource(test_db, task_id_value=task_id_value, user_id=1069)

    task = store.get_by_id(test_db, task_id=task_id_value, owner_user_id=1069)

    assert task is not None
    assert task.id == task_id_value
    assert task.user_id == 1069
    assert task.__table__.name == TaskResource.__tablename__
    assert store.get_by_id(test_db, task_id=task_id_value, owner_user_id=1070) is None


def test_single_id_queries_use_route_for_redis_style_id(test_db):
    store = ShardedTaskStore()
    task_id_value = 106
    add_legacy_resource(
        test_db,
        task_id_value=task_id_value,
        user_id=1074,
        client_origin="web",
    )

    assert store.get_active_task(
        test_db,
        task_id=task_id_value,
        owner_user_id=1074,
        client_origin="web",
    )
    assert store.get_task_by_states(
        test_db,
        task_id=task_id_value,
        states=[TaskResource.STATE_ACTIVE],
        owner_user_id=1074,
        client_origin="web",
    )


def test_get_by_id_falls_back_to_legacy_when_route_missing(test_db):
    store = ShardedTaskStore()
    add_legacy_resource(test_db, task_id_value=103, user_id=1071)

    task = store.get_by_id(test_db, task_id=103, owner_user_id=1071)

    assert task is not None
    assert task.id == 103
    assert task.__table__.name == TaskResource.__tablename__


def test_list_by_ids_mixes_route_hits_and_legacy_fallback(test_db):
    store = ShardedTaskStore()
    route_task = add_legacy_resource(test_db, task_id_value=104, user_id=1072)
    legacy_task = add_legacy_resource(test_db, task_id_value=105, user_id=1073)

    tasks = store.list_by_ids(test_db, task_ids=[route_task.id, legacy_task.id])

    assert {task.id for task in tasks} == {104, 105}
    assert {task.id: task.__table__.name for task in tasks} == {
        104: TaskResource.__tablename__,
        105: TaskResource.__tablename__,
    }


def test_get_by_id_reads_new_task_id_from_shard_without_legacy_row(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    task_id_value = new_task_id(31, 1)
    add_shard_resource(test_db, task_id_value=task_id_value, user_id=31)

    task = store.get_by_id(test_db, task_id=task_id_value, owner_user_id=31)

    assert task is not None
    assert task.id == task_id_value
    assert task.user_id == 31
    assert (
        test_db.query(TaskResource).filter(TaskResource.id == task_id_value).first()
        is None
    )
    assert store.is_valid_task_id(test_db, task_id=task_id_value, owner_user_id=31)
    assert store.get_by_id(test_db, task_id=task_id_value, owner_user_id=99) is None
    assert not store.is_valid_task_id(
        test_db,
        task_id=task_id_value,
        owner_user_id=99,
    )


def test_get_by_id_for_update_reads_new_task_id_from_shard(test_db):
    store = ShardedTaskStore()
    task_id_value = new_task_id(31, 2)
    add_shard_resource(test_db, task_id_value=task_id_value, user_id=31)

    task = store.get_by_id_for_update(
        test_db,
        task_id=task_id_value,
        owner_user_id=31,
    )

    assert task is not None
    assert task.id == task_id_value
    assert task.__table__.name == task_model_for_task_id(task_id_value).__table__.name
    assert (
        store.get_by_id_for_update(
            test_db,
            task_id=task_id_value,
            owner_user_id=99,
        )
        is None
    )


def test_get_by_id_rejects_same_slot_different_owner(test_db, fixed_clock):
    store = ShardedTaskStore()
    task_id_value = new_task_id(1068, 1)
    add_shard_resource(test_db, task_id_value=task_id_value, user_id=1068)

    assert uid_from_id(task_id_value) == 1068
    assert store.get_by_id(test_db, task_id=task_id_value, owner_user_id=44) is None
    assert not store.is_valid_task_id(
        test_db,
        task_id=task_id_value,
        owner_user_id=44,
    )


def test_get_by_id_reads_legacy_task_id_from_legacy_table(test_db):
    store = ShardedTaskStore()
    add_legacy_resource(test_db, task_id_value=331, user_id=32)

    task = store.get_by_id(test_db, task_id=331, owner_user_id=32)

    assert task is not None
    assert task.id == 331
    assert store.get_by_id(test_db, task_id=331, owner_user_id=99) is None


def test_single_task_queries_apply_state_kind_namespace_and_origin_filters(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    active_id = new_task_id(33, 1)
    deleted_id = new_task_id(33, 2)
    system_id = new_task_id(33, 3)
    workspace_id = new_task_id(33, 4)
    add_shard_resource(
        test_db,
        task_id_value=active_id,
        user_id=33,
        client_origin="web",
    )
    add_shard_resource(
        test_db,
        task_id_value=deleted_id,
        user_id=33,
        state=TaskResource.STATE_DELETED,
        client_origin="web",
    )
    add_shard_resource(
        test_db,
        task_id_value=system_id,
        user_id=33,
        namespace="system",
        client_origin="web",
    )
    add_shard_resource(
        test_db,
        task_id_value=workspace_id,
        user_id=33,
        kind="Workspace",
        client_origin="web",
    )

    assert store.get_active_task(test_db, task_id=active_id, client_origin="web")
    assert (
        store.get_active_task(test_db, task_id=active_id, client_origin="mobile")
        is None
    )
    assert (
        store.get_active_task(test_db, task_id=deleted_id, client_origin="web") is None
    )
    assert (
        store.get_active_task(test_db, task_id=workspace_id, client_origin="web")
        is None
    )
    assert store.get_regular_active_task(
        test_db, task_id=active_id, client_origin="web"
    )
    assert (
        store.get_regular_active_task(test_db, task_id=system_id, client_origin="web")
        is None
    )
    assert (
        store.get_non_deleted_task(test_db, task_id=deleted_id, owner_user_id=33)
        is None
    )


def test_get_task_by_states_applies_states_kind_user_owner_and_origin_filters(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    running_id = new_task_id(34, 1)
    workspace_id = new_task_id(34, 2)
    add_shard_resource(
        test_db,
        task_id_value=running_id,
        user_id=340,
        state=TaskResource.STATE_SUBSCRIPTION,
        client_origin="web",
    )
    add_shard_resource(
        test_db,
        task_id_value=workspace_id,
        user_id=340,
        kind="Workspace",
        state=TaskResource.STATE_SUBSCRIPTION,
        client_origin="web",
    )

    task = store.get_task_by_states(
        test_db,
        task_id=running_id,
        states=[TaskResource.STATE_SUBSCRIPTION],
        user_id=340,
        owner_user_id=340,
        client_origin="web",
    )

    assert task is not None
    assert task.id == running_id
    assert (
        store.get_task_by_states(
            test_db,
            task_id=running_id,
            states=[TaskResource.STATE_ACTIVE],
            user_id=340,
            owner_user_id=340,
            client_origin="web",
        )
        is None
    )
    assert (
        store.get_task_by_states(
            test_db,
            task_id=running_id,
            states=[TaskResource.STATE_SUBSCRIPTION],
            user_id=341,
            owner_user_id=340,
            client_origin="web",
        )
        is None
    )
    assert (
        store.get_task_by_states(
            test_db,
            task_id=running_id,
            states=[TaskResource.STATE_SUBSCRIPTION],
            user_id=340,
            owner_user_id=341,
            client_origin="web",
        )
        is None
    )
    assert (
        store.get_task_by_states(
            test_db,
            task_id=workspace_id,
            states=[TaskResource.STATE_SUBSCRIPTION],
            kind="Task",
            user_id=340,
            owner_user_id=340,
            client_origin="web",
        )
        is None
    )


def test_additional_single_task_queries_read_shard_and_preserve_legacy_fallback(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    shard_id = new_task_id(36, 1)
    archived_id = new_task_id(36, 2)
    json_deleted_id = new_task_id(36, 3)
    workspace_ref_id = new_task_id(36, 4)
    legacy_id = 361
    add_shard_resource(
        test_db,
        task_id_value=shard_id,
        user_id=36,
        client_origin="web",
        payload={"status": {"status": "READY"}},
    )
    add_shard_resource(
        test_db,
        task_id_value=archived_id,
        user_id=36,
        state=TaskResource.STATE_ARCHIVED,
        client_origin="web",
    )
    add_shard_resource(
        test_db,
        task_id_value=json_deleted_id,
        user_id=36,
        client_origin="web",
        payload={"status": {"status": "DELETE"}},
    )
    add_shard_resource(
        test_db,
        task_id_value=workspace_ref_id,
        user_id=36,
        payload={
            "spec": {"workspaceRef": {"name": "ws-shard", "namespace": "default"}}
        },
    )
    add_legacy_resource(
        test_db,
        task_id_value=legacy_id,
        user_id=36,
        client_origin="web",
    )

    assert (
        store.get_owned_active_task(
            test_db, task_id=shard_id, user_id=36, client_origin="web"
        ).id
        == shard_id
    )
    assert (
        store.get_active_non_deleted_task(
            test_db, task_id=shard_id, owner_user_id=36, client_origin="web"
        ).id
        == shard_id
    )
    assert (
        store.get_active_non_deleted_task(
            test_db, task_id=json_deleted_id, owner_user_id=36, client_origin="web"
        )
        is None
    )
    assert (
        store.get_active_or_archived_task(
            test_db, task_id=archived_id, owner_user_id=36, client_origin="web"
        ).id
        == archived_id
    )
    assert (
        store.get_owned_task_by_state(
            test_db,
            task_id=archived_id,
            user_id=36,
            state=TaskResource.STATE_ARCHIVED,
            client_origin="web",
        ).id
        == archived_id
    )
    assert (
        store.get_task_by_workspace_ref(
            test_db,
            user_id=36,
            workspace_name="ws-shard",
            workspace_namespace="default",
        ).id
        == workspace_ref_id
    )
    assert (
        store.get_owned_active_task(
            test_db, task_id=legacy_id, user_id=36, client_origin="web"
        ).id
        == legacy_id
    )
    assert (
        store.get_owned_active_task(
            test_db, task_id=shard_id, user_id=99, client_origin="web"
        )
        is None
    )


def test_get_active_workspace_by_id_reads_new_workspace_from_shard(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    workspace_id = new_task_id(35, 1)
    add_shard_resource(
        test_db,
        task_id_value=workspace_id,
        user_id=35,
        kind="Workspace",
    )

    workspace = store.get_active_workspace_by_id(
        test_db,
        workspace_id=workspace_id,
        owner_user_id=35,
    )

    assert workspace is not None
    assert workspace.id == workspace_id
    assert (
        store.get_active_workspace_by_id(
            test_db,
            workspace_id=workspace_id,
            owner_user_id=99,
        )
        is None
    )


def test_workspace_id_queries_read_shards_and_preserve_input_order(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    legacy = add_legacy_resource(
        test_db,
        task_id_value=371,
        user_id=37,
        kind="Workspace",
    )
    shard_a = add_shard_resource(
        test_db,
        task_id_value=new_task_id(37, 1),
        user_id=37,
        kind="Workspace",
    )
    shard_b = add_shard_resource(
        test_db,
        task_id_value=new_task_id(38, 1),
        user_id=37,
        kind="Workspace",
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(37, 2),
        user_id=37,
        kind="Workspace",
        state=TaskResource.STATE_DELETED,
    )
    workspace_ids = [shard_b.id, legacy.id, shard_a.id]

    assert (
        store.get_owned_active_workspace_by_id(
            test_db, workspace_id=shard_a.id, user_id=37
        ).id
        == shard_a.id
    )
    workspaces = store.list_active_workspaces_by_ids(
        test_db,
        workspace_ids=workspace_ids,
        owner_user_id=37,
    )

    assert [workspace.id for workspace in workspaces] == workspace_ids


def test_list_by_ids_merges_legacy_and_multiple_shards(test_db, fixed_clock):
    store = ShardedTaskStore()
    legacy = add_legacy_resource(test_db, task_id_value=401, user_id=41)
    shard_a_id = new_task_id(42, 1)
    shard_b_id = new_task_id(43, 1)
    shard_a = add_shard_resource(
        test_db,
        task_id_value=shard_a_id,
        user_id=41,
    )
    shard_b = add_shard_resource(
        test_db,
        task_id_value=shard_b_id,
        user_id=41,
    )
    add_shard_resource(test_db, task_id_value=new_task_id(44, 1), user_id=99)

    tasks = store.list_by_ids(
        test_db,
        task_ids=[legacy.id, shard_a.id, shard_b.id],
        owner_user_id=41,
    )

    assert {task.id for task in tasks} == {legacy.id, shard_a.id, shard_b.id}


def test_list_by_ids_ordered_preserves_input_order_across_legacy_and_shards(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    legacy = add_legacy_resource(test_db, task_id_value=501, user_id=51)
    shard_a = add_shard_resource(
        test_db,
        task_id_value=new_task_id(52, 1),
        user_id=51,
    )
    shard_b = add_shard_resource(
        test_db,
        task_id_value=new_task_id(53, 1),
        user_id=51,
    )
    task_ids = [shard_b.id, legacy.id, shard_a.id]

    tasks = store.list_by_ids_ordered(
        test_db,
        task_ids=task_ids,
        owner_user_id=51,
    )

    assert [task.id for task in tasks] == task_ids


def test_owner_name_and_workspace_queries_read_owner_shard_and_legacy(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    shard_task_id = new_task_id(61, 1)
    shard_workspace_id = new_task_id(61, 2)
    legacy_task = add_legacy_resource(
        test_db,
        task_id_value=601,
        user_id=61,
        name="legacy-task",
    )
    legacy_workspace = add_legacy_resource(
        test_db,
        task_id_value=602,
        user_id=61,
        kind="Workspace",
        name="legacy-workspace",
    )
    shard_task = add_shard_resource(
        test_db,
        task_id_value=shard_task_id,
        user_id=61,
        name="shard-task",
    )
    shard_workspace = add_shard_resource(
        test_db,
        task_id_value=shard_workspace_id,
        user_id=61,
        kind="Workspace",
        name="shard-workspace",
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(62, 1),
        user_id=62,
        name="shard-task",
    )

    assert (
        store.get_owned_task_by_name(
            test_db, user_id=61, name="shard-task", namespace="default"
        ).id
        == shard_task.id
    )
    assert (
        store.get_owned_task_by_name(
            test_db, user_id=61, name="legacy-task", namespace="default"
        ).id
        == legacy_task.id
    )
    assert (
        store.get_workspace_by_ref(
            test_db, user_id=61, name="shard-workspace", namespace="default"
        ).id
        == shard_workspace.id
    )
    assert (
        store.get_workspace_by_ref(
            test_db, user_id=61, name="legacy-workspace", namespace="default"
        ).id
        == legacy_workspace.id
    )


def test_kind_and_workspace_ref_lists_merge_owner_shard_and_legacy(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    legacy_kind = add_legacy_resource(
        test_db,
        task_id_value=611,
        user_id=63,
        kind="Workspace",
        name="kind-legacy",
    )
    shard_kind = add_shard_resource(
        test_db,
        task_id_value=new_task_id(63, 1),
        user_id=63,
        kind="Workspace",
        name="kind-shard",
    )
    legacy_ref = add_legacy_resource(
        test_db,
        task_id_value=612,
        user_id=63,
        kind="Workspace",
        name="ref-legacy",
    )
    shard_ref = add_shard_resource(
        test_db,
        task_id_value=new_task_id(64, 1),
        user_id=64,
        kind="Workspace",
        name="ref-shard",
    )

    kind_resources = store.list_kind_resources(
        test_db,
        kind="Workspace",
        user_id=63,
        namespace="default",
    )
    named_kind = store.get_kind_resource(
        test_db,
        kind="Workspace",
        user_id=63,
        namespace="default",
        name="kind-shard",
    )
    ref_resources = store.list_workspaces_by_refs(
        test_db,
        refs=[
            WorkspaceRefLookup(user_id=64, namespace="default", name="ref-shard"),
            WorkspaceRefLookup(user_id=63, namespace="default", name="ref-legacy"),
        ],
    )

    assert {resource.id for resource in kind_resources} >= {
        legacy_kind.id,
        shard_kind.id,
    }
    assert named_kind.id == shard_kind.id
    assert [resource.id for resource in ref_resources] == [shard_ref.id, legacy_ref.id]


def test_list_active_workspaces_by_user_merges_owner_shard_and_legacy(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    legacy = add_legacy_resource(
        test_db,
        task_id_value=701,
        user_id=71,
        kind="Workspace",
    )
    shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(71, 1),
        user_id=71,
        kind="Workspace",
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(71, 2),
        user_id=71,
        kind="Workspace",
        state=TaskResource.STATE_DELETED,
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(72, 1),
        user_id=72,
        kind="Workspace",
    )

    workspaces = store.list_active_workspaces_by_user(test_db, user_id=71)

    assert {workspace.id for workspace in workspaces} == {legacy.id, shard.id}


def test_list_regular_active_tasks_reads_user_shard_with_legacy_filters_and_limit(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    now = datetime(2026, 6, 12, 10, 0, 0)
    legacy = add_legacy_resource(
        test_db,
        task_id_value=801,
        user_id=81,
        client_origin="web",
        updated_at=now,
    )
    newer_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(81, 1),
        user_id=81,
        client_origin="web",
        updated_at=now + timedelta(minutes=2),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(81, 2),
        user_id=81,
        namespace="system",
        client_origin="web",
        updated_at=now + timedelta(minutes=3),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(81, 3),
        user_id=81,
        client_origin="mobile",
        updated_at=now + timedelta(minutes=4),
    )

    tasks = store.list_regular_active_tasks(
        test_db,
        user_id=81,
        client_origin="web",
        exclude_system_namespace=True,
        limit=2,
        order_by_updated_at_desc=True,
    )

    assert [task.id for task in tasks] == [newer_shard.id, legacy.id]


def test_list_regular_active_tasks_reads_each_requested_user_shard(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    first = add_shard_resource(
        test_db,
        task_id_value=new_task_id(82, 1),
        user_id=82,
    )
    second = add_shard_resource(
        test_db,
        task_id_value=new_task_id(83, 1),
        user_id=83,
    )
    legacy = add_legacy_resource(test_db, task_id_value=803, user_id=83)
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(84, 1),
        user_id=84,
    )

    tasks = store.list_regular_active_tasks(
        test_db,
        user_ids=[82, 83],
        order_by_id_desc=True,
    )

    assert [task.id for task in tasks] == sorted(
        [first.id, second.id, legacy.id], reverse=True
    )


def test_list_regular_active_tasks_deduplicates_users_on_same_shard(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    first_user_id = 85
    same_shard_user_id = first_user_id + SHARD_COUNT
    first = add_shard_resource(
        test_db,
        task_id_value=new_task_id(first_user_id, 1),
        user_id=first_user_id,
    )
    second = add_shard_resource(
        test_db,
        task_id_value=new_task_id(same_shard_user_id, 1),
        user_id=same_shard_user_id,
    )

    tasks = store.list_regular_active_tasks(
        test_db,
        user_ids=[first_user_id, same_shard_user_id],
        order_by_id_desc=True,
    )

    assert [task.id for task in tasks] == sorted([first.id, second.id], reverse=True)


def test_list_archived_tasks_merges_owner_shard_and_legacy_with_pagination(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    now = datetime(2026, 6, 12, 11, 0, 0)
    older = add_legacy_resource(
        test_db,
        task_id_value=901,
        user_id=91,
        state=TaskResource.STATE_ARCHIVED,
        client_origin="web",
        updated_at=now,
    )
    newer = add_shard_resource(
        test_db,
        task_id_value=new_task_id(91, 1),
        user_id=91,
        state=TaskResource.STATE_ARCHIVED,
        client_origin="web",
        updated_at=now + timedelta(minutes=1),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(91, 2),
        user_id=91,
        state=TaskResource.STATE_ACTIVE,
        client_origin="web",
    )

    tasks, total = store.list_archived_tasks(
        test_db,
        user_id=91,
        skip=1,
        limit=1,
        client_origin="web",
    )

    assert total == 2
    assert [task.id for task in tasks] == [older.id]
    assert newer.id != older.id


def test_project_owner_queries_count_list_and_clear_owner_shard_plus_legacy(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    legacy = add_legacy_resource(
        test_db,
        task_id_value=1001,
        user_id=101,
        project_id=7,
        client_origin="web",
    )
    shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(101, 1),
        user_id=101,
        project_id=7,
        client_origin="web",
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(101, 2),
        user_id=101,
        project_id=7,
        client_origin="mobile",
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(101, 3),
        user_id=101,
        project_id=8,
        client_origin="web",
    )

    assert (
        store.count_active_project_tasks(
            test_db,
            project_id=7,
            owner_user_id=101,
            client_origin="web",
        )
        == 2
    )
    project_tasks = store.list_archivable_active_tasks(
        test_db,
        user_id=101,
        scope="project_id",
        project_id=7,
        client_origin="web",
    )
    assert {task.id for task in project_tasks} == {legacy.id, shard.id}

    updated = store.clear_project_for_owned_tasks(
        test_db,
        user_id=101,
        project_id=7,
        client_origin="web",
    )
    test_db.flush()

    assert updated == 2
    assert legacy.project_id == 0
    assert shard.project_id == 0


def test_project_task_queries_and_counts_include_shards(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    now = datetime(2026, 6, 12, 11, 30, 0)
    legacy = add_legacy_resource(
        test_db,
        task_id_value=1002,
        user_id=102,
        project_id=8,
        client_origin="web",
        updated_at=now,
        payload={"status": {"status": "READY"}},
    )
    shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(102, 1),
        user_id=102,
        project_id=8,
        client_origin="web",
        updated_at=now + timedelta(minutes=1),
        payload={"status": {"status": "READY"}},
    )
    json_deleted = add_shard_resource(
        test_db,
        task_id_value=new_task_id(102, 2),
        user_id=102,
        project_id=9,
        client_origin="web",
        payload={"status": {"status": "DELETE"}},
    )

    tasks = store.list_active_project_tasks(
        test_db,
        project_id=8,
        owner_user_id=102,
        client_origin="web",
    )
    task = store.get_active_project_task(
        test_db,
        task_id=shard.id,
        project_id=8,
        owner_user_id=102,
        client_origin="web",
    )
    count = store.count_non_deleted_by_ids(
        test_db,
        task_ids=[legacy.id, shard.id, json_deleted.id],
        owner_user_id=102,
    )

    assert [resource.id for resource in tasks] == [shard.id, legacy.id]
    assert task.id == shard.id
    assert count == 2


def test_list_owned_and_personal_task_ids_merge_legacy_and_owner_shard(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    now = datetime(2026, 6, 12, 12, 0, 0)
    legacy_personal = add_legacy_resource(
        test_db,
        task_id_value=1101,
        user_id=111,
        client_origin="web",
        created_at=now,
    )
    shard_personal = add_shard_resource(
        test_db,
        task_id_value=new_task_id(111, 1),
        user_id=111,
        client_origin="web",
        created_at=now + timedelta(minutes=2),
    )
    shard_group = add_shard_resource(
        test_db,
        task_id_value=new_task_id(111, 2),
        user_id=111,
        client_origin="web",
        is_group_chat=True,
        created_at=now + timedelta(minutes=3),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(111, 3),
        user_id=111,
        namespace="system",
        created_at=now + timedelta(minutes=4),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(111, 4),
        user_id=111,
        state=TaskResource.STATE_ARCHIVED,
        created_at=now + timedelta(minutes=5),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(111, 5),
        user_id=111,
        kind="Workspace",
        created_at=now + timedelta(minutes=6),
    )
    add_shard_resource(
        test_db,
        task_id_value=new_task_id(112, 1),
        user_id=112,
        created_at=now + timedelta(minutes=7),
    )

    owned_ids, owned_total = store.list_owned_task_ids(
        test_db,
        user_id=111,
        skip=1,
        limit=1,
        extra_limit=1,
    )
    personal_ids, personal_total = store.list_personal_task_ids(
        test_db,
        user_id=111,
        skip=0,
        limit=10,
        extra_limit=0,
        client_origin="web",
    )

    assert owned_total == 3
    assert owned_ids == [shard_personal.id, legacy_personal.id]
    assert personal_total == 1
    assert personal_ids == [shard_personal.id]
    assert shard_group.id not in personal_ids


def test_list_personal_task_ids_uses_lightweight_candidate_scan(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    now = datetime(2026, 6, 12, 12, 0, 0)
    user_id = 113
    for index in range(5):
        add_legacy_resource(
            test_db,
            task_id_value=1130 + index,
            user_id=user_id,
            client_origin="web",
            created_at=now + timedelta(minutes=index),
        )
        add_shard_resource(
            test_db,
            task_id_value=new_task_id(user_id, index + 1),
            user_id=user_id,
            client_origin="web",
            created_at=now + timedelta(minutes=index + 10),
        )
    test_db.commit()

    statements: list[str] = []

    def collect_selects(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement.upper())

    connection = test_db.connection()
    event.listen(connection, "before_cursor_execute", collect_selects)
    try:
        task_ids, total = store.list_personal_task_ids(
            test_db,
            user_id=user_id,
            skip=0,
            limit=2,
            extra_limit=1,
            client_origin="web",
        )
    finally:
        event.remove(connection, "before_cursor_execute", collect_selects)

    assert total == 5
    assert len(task_ids) == 3
    row_selects = [
        statement
        for statement in statements
        if "FROM TASKS_" in statement
        and "COUNT" not in statement
        and ".USER_ID" in statement
    ]
    assert row_selects
    assert all("JSON" not in statement for statement in row_selects)
    assert all("ORDER BY" in statement for statement in row_selects)
    assert all("COUNT" not in statement for statement in row_selects)


def test_list_accessible_task_ids_reads_members_by_id_across_shards(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    now = datetime(2026, 6, 12, 13, 0, 0)
    _, owned_legacy = add_migrated_legacy_resource(
        test_db,
        task_id_value=1201,
        user_id=121,
        created_at=now,
    )
    owned_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(121, 1),
        user_id=121,
        created_at=now + timedelta(minutes=4),
    )
    _, joined_legacy = add_migrated_legacy_resource(
        test_db,
        task_id_value=1202,
        user_id=122,
        created_at=now + timedelta(minutes=1),
    )
    joined_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(123, 1),
        user_id=123,
        created_at=now + timedelta(minutes=3),
    )
    copied_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(124, 1),
        user_id=124,
        created_at=now + timedelta(minutes=5),
    )
    pending_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(125, 1),
        user_id=125,
        created_at=now + timedelta(minutes=6),
    )
    deleted_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(126, 1),
        user_id=126,
        state=TaskResource.STATE_DELETED,
        created_at=now + timedelta(minutes=7),
    )
    system_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(127, 1),
        user_id=127,
        namespace="system",
        created_at=now + timedelta(minutes=8),
    )
    add_resource_member(test_db, task_id_value=joined_legacy.id, user_id=121)
    add_resource_member(test_db, task_id_value=joined_shard.id, user_id=121)
    add_resource_member(test_db, task_id_value=owned_shard.id, user_id=121)
    add_resource_member(
        test_db,
        task_id_value=copied_joined.id,
        user_id=121,
        copied_resource_id=999,
    )
    add_resource_member(
        test_db,
        task_id_value=pending_joined.id,
        user_id=121,
        status=MemberStatus.PENDING,
    )
    add_resource_member(test_db, task_id_value=deleted_joined.id, user_id=121)
    add_resource_member(test_db, task_id_value=system_joined.id, user_id=121)

    statements: list[str] = []

    def collect_selects(_conn, _cursor, statement, _parameters, _context, _executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement.upper())

    connection = test_db.connection()
    event.listen(connection, "before_cursor_execute", collect_selects)
    try:
        task_ids, total = store.list_accessible_task_ids(
            test_db,
            user_id=121,
            skip=0,
            limit=3,
            extra_limit=1,
        )
        tasks = store.list_api_tasks_by_ids(test_db, task_ids=task_ids)
    finally:
        event.remove(connection, "before_cursor_execute", collect_selects)

    assert total == 4
    assert task_ids == [
        owned_shard.id,
        joined_shard.id,
        joined_legacy.id,
        owned_legacy.id,
    ]
    assert {task.id for task in tasks} == set(task_ids)
    assert not any(" FROM TASKS " in statement for statement in statements)
    assert any(
        "COUNT" in statement and "FROM TASKS_" in statement for statement in statements
    )
    assert any(
        "FROM TASKS_" in statement and "LIMIT" in statement for statement in statements
    )


def test_group_task_ids_merge_owned_and_member_shards_with_filters(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    owned_legacy = add_legacy_resource(
        test_db,
        task_id_value=1301,
        user_id=131,
        is_group_chat=True,
    )
    owned_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(131, 1),
        user_id=131,
        is_group_chat=True,
    )
    joined_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(132, 1),
        user_id=132,
        is_group_chat=True,
    )
    personal_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(133, 1),
        user_id=133,
        is_group_chat=False,
    )
    copied_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(134, 1),
        user_id=134,
        is_group_chat=True,
    )
    add_resource_member(test_db, task_id_value=joined_shard.id, user_id=131)
    add_resource_member(test_db, task_id_value=personal_joined.id, user_id=131)
    add_resource_member(
        test_db,
        task_id_value=copied_joined.id,
        user_id=131,
        copied_resource_id=999,
    )

    accessible_ids = store.list_group_task_ids_for_accessible_user(
        test_db,
        user_id=131,
    )
    owned_ids = store.list_group_task_ids_for_owned_tasks(test_db, user_id=131)

    assert accessible_ids == {owned_legacy.id, owned_shard.id, joined_shard.id}
    assert owned_ids == {owned_legacy.id, owned_shard.id}


def test_active_task_lists_merge_owned_and_member_shards(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    owned_legacy = add_legacy_resource(test_db, task_id_value=1401, user_id=141)
    owned_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(141, 1),
        user_id=141,
    )
    joined_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(142, 1),
        user_id=142,
    )
    copied_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(143, 1),
        user_id=143,
    )
    deleted_joined = add_shard_resource(
        test_db,
        task_id_value=new_task_id(144, 1),
        user_id=144,
        state=TaskResource.STATE_DELETED,
    )
    add_resource_member(test_db, task_id_value=joined_shard.id, user_id=141)
    add_resource_member(test_db, task_id_value=owned_shard.id, user_id=141)
    add_resource_member(
        test_db,
        task_id_value=copied_joined.id,
        user_id=141,
        copied_resource_id=999,
    )
    add_resource_member(test_db, task_id_value=deleted_joined.id, user_id=141)

    owned_tasks = store.list_active_tasks_for_user(test_db, user_id=141)
    accessible_tasks = store.list_accessible_active_tasks_for_user(
        test_db,
        user_id=141,
    )

    assert {task.id for task in owned_tasks} == {owned_legacy.id, owned_shard.id}
    assert {task.id for task in accessible_tasks} == {
        owned_legacy.id,
        owned_shard.id,
        joined_shard.id,
    }


def test_owned_state_archived_and_delete_mutations_handle_shard_rows(
    test_db,
    fixed_clock,
):
    store = ShardedTaskStore()
    legacy = add_legacy_resource(
        test_db,
        task_id_value=1501,
        user_id=151,
        state=TaskResource.STATE_ARCHIVED,
        client_origin="web",
    )
    shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(151, 1),
        user_id=151,
        state=TaskResource.STATE_ARCHIVED,
        client_origin="web",
    )
    active_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(151, 2),
        user_id=151,
        client_origin="web",
    )
    delete_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(151, 3),
        user_id=151,
        client_origin="web",
    )
    update_shard = add_shard_resource(
        test_db,
        task_id_value=new_task_id(151, 4),
        user_id=151,
        client_origin="web",
    )

    archived_ids = store.list_archived_task_ids(
        test_db,
        user_id=151,
        client_origin="web",
    )
    owned_tasks = store.list_owned_tasks_by_ids_and_states(
        test_db,
        task_ids=[shard.id, legacy.id],
        user_id=151,
        states=[TaskResource.STATE_ARCHIVED],
        client_origin="web",
    )
    store.set_archive_state(
        test_db,
        task=active_shard,
        state=TaskResource.STATE_ARCHIVED,
        commit=False,
    )
    store.soft_delete_task(
        test_db,
        task=delete_shard,
        payload={"status": {"status": "DELETE"}},
    )
    store.update_fields(test_db, task=update_shard, project_id=42)
    store.update_json(test_db, task=update_shard, payload={"spec": {"updated": True}})
    store.delete_resource(test_db, resource=shard)
    test_db.flush()

    assert set(archived_ids) == {legacy.id, shard.id}
    assert [task.id for task in owned_tasks] == [shard.id, legacy.id]
    assert active_shard.is_active == TaskResource.STATE_ARCHIVED
    assert delete_shard.is_active == TaskResource.STATE_DELETED
    assert update_shard.project_id == 42
    assert update_shard.json == {"spec": {"updated": True}}
    assert count_shard_rows(test_db, shard.id) == 0


def test_create_placeholder_task_id_raises_clear_error_when_no_allocator(test_db):
    # When no global_id_allocator is provided, allocation must raise TaskIdAllocationError.
    store = ShardedTaskStore()

    with pytest.raises(TaskIdAllocationError):
        store.create_placeholder_task_id(test_db, user_id=22)

    assert count_legacy_tasks(test_db) == 0


def test_create_placeholder_task_id_rejects_legacy_uuid_style_allocator_id(test_db):
    store = ShardedTaskStore(
        global_id_allocator=RecordingGlobalIdAllocator([5310397443737613])
    )

    with pytest.raises(TaskIdAllocationError):
        store.create_placeholder_task_id(test_db, user_id=1)

    assert count_legacy_tasks(test_db) == 0


def test_real_create_uses_fallback_sequence_and_retries_duplicates(
    test_db,
    fixed_clock,
):
    duplicate_id = encode_user_scoped_id(23, 11)
    retry_id = encode_user_scoped_id(23, 12)
    allocator = RecordingGlobalIdAllocator(task_ids=[duplicate_id, retry_id])
    duplicate_model = task_model_for_task_id(duplicate_id)
    test_db.add(
        duplicate_model(
            id=duplicate_id,
            user_id=23,
            kind="Task",
            name="duplicate",
            namespace="default",
            json={"kind": "Task"},
            is_active=TaskResource.STATE_ACTIVE,
            client_origin="frontend",
        )
    )
    test_db.flush()
    store = ShardedTaskStore(global_id_allocator=allocator)

    task = store.create_pending_task_shell(
        test_db,
        user_id=23,
        client_origin="frontend",
    )
    test_db.flush()

    assert task.id == retry_id
    assert task.id != duplicate_id
    assert count_shard_rows(test_db, task.id) == 1
    assert allocator.task_calls == 2


def test_real_create_raises_integrity_error_after_three_duplicate_fallbacks(
    test_db,
    fixed_clock,
):
    duplicate_ids = [encode_user_scoped_id(24, seq) for seq in [31, 32, 33]]
    for dup_id in duplicate_ids:
        duplicate_model = task_model_for_task_id(dup_id)
        test_db.add(
            duplicate_model(
                id=dup_id,
                user_id=24,
                kind="Task",
                name=f"duplicate-{dup_id}",
                namespace="default",
                json={"kind": "Task"},
                is_active=TaskResource.STATE_ACTIVE,
                client_origin="frontend",
            )
        )
    test_db.flush()
    allocator = RecordingGlobalIdAllocator(task_ids=list(duplicate_ids))
    store = ShardedTaskStore(global_id_allocator=allocator)

    with pytest.raises(IntegrityError):
        store.create_pending_task_shell(
            test_db,
            user_id=24,
            client_origin="frontend",
        )

    assert allocator.task_calls == 3


def test_registration_replaces_global_task_store():
    import app.stores.tasks as task_stores
    from wecode.task_sharding.store_registration import (
        install_task_sharding_task_store,
    )

    original_store = task_stores.task_store
    try:
        installed = install_task_sharding_task_store()

        assert isinstance(installed, ShardedTaskStore)
        assert task_stores.task_store is installed
    finally:
        task_stores.task_store = original_store


def test_sharded_task_store_keeps_legacy_store_behavior_available():
    assert isinstance(ShardedTaskStore(), SqlAlchemyTaskStore)
