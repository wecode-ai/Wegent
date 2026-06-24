from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.execution.dispatcher import ExecutionDispatcher
from shared.models import ExecutionRequest
from shared.models.responses_api import ResponsesAPIStreamEvents
from wecode.task_sharding.shard import (
    SHARD_COUNT,
    subtask_model_for_task_id,
    task_model_for_task_id,
    task_model_for_user,
)
from wecode.task_sharding.subtask_store import ShardedSubtaskStore
from wecode.task_sharding.task_store import ShardedTaskStore
from wecode.task_sharding.uuid_factory.user_scoped_id_factory import (
    encode_user_scoped_id,
)

pytestmark = pytest.mark.unit

SEQUENCE_BASE = 1 << 22


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        subtask_model_for_task_id(new_task_id(uid, 0)).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def new_subtask_id(owner_user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(owner_user_id & 0xFFFF, SEQUENCE_BASE + sequence + 1)


def task_payload(team_name: str = "agent") -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": "task-a", "namespace": "default"},
        "spec": {
            "title": "Task A",
            "prompt": "hello",
            "teamRef": {"name": team_name, "namespace": "default"},
            "workspaceRef": {"name": "workspace-a", "namespace": "default"},
        },
    }


def add_sharded_task(test_db, *, task_id_value: int, user_id: int) -> TaskResource:
    model = task_model_for_task_id(task_id_value)
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json=task_payload(),
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_legacy_task(test_db, *, task_id_value: int, user_id: int) -> TaskResource:
    task = TaskResource(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"legacy-task-{task_id_value}",
        namespace="default",
        json=task_payload(),
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="frontend",
        project_id=0,
        is_group_chat=False,
    )
    test_db.add(task)
    test_db.flush()
    return task


def add_sharded_subtask(
    test_db,
    *,
    subtask_id_value: int,
    task_id_value: int,
    user_id: int,
    status: SubtaskStatus = SubtaskStatus.PENDING,
    executor_deleted_at: bool = False,
) -> object:
    model = subtask_model_for_task_id(task_id_value)
    subtask = model(
        id=subtask_id_value,
        user_id=user_id,
        task_id=task_id_value,
        team_id=11,
        title="subtask-a",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="default",
        executor_name="executor-a",
        executor_deleted_at=executor_deleted_at,
        prompt="hello",
        status=status,
        progress=0,
        message_id=1,
        parent_id=0,
        error_message="",
        result=None,
    )
    test_db.add(subtask)
    test_db.flush()
    return subtask


def add_legacy_subtask(
    test_db,
    *,
    subtask_id_value: int,
    task_id_value: int,
    user_id: int,
    status: SubtaskStatus = SubtaskStatus.PENDING,
    executor_deleted_at: bool = False,
) -> Subtask:
    subtask = Subtask(
        id=subtask_id_value,
        user_id=user_id,
        task_id=task_id_value,
        team_id=11,
        title="legacy-subtask-a",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="default",
        executor_name="executor-a",
        executor_deleted_at=executor_deleted_at,
        prompt="hello",
        status=status,
        progress=0,
        message_id=1,
        parent_id=0,
        error_message="",
        result=None,
    )
    test_db.add(subtask)
    test_db.flush()
    return subtask


def install_entrypoint_stores(monkeypatch):
    task_store = ShardedTaskStore()
    subtask_store = ShardedSubtaskStore()

    import app.stores.tasks as task_stores
    from app.api.endpoints.internal import callback
    from app.services.execution import dispatcher

    monkeypatch.setattr(task_stores, "task_store", task_store)
    monkeypatch.setattr(task_stores, "subtask_store", subtask_store)
    monkeypatch.setattr(callback, "task_store", task_store)
    monkeypatch.setattr(dispatcher, "task_store", task_store)
    monkeypatch.setattr(dispatcher, "subtask_store", subtask_store)
    return task_store, subtask_store


def test_execution_entrypoints_do_not_query_task_or_subtask_models_directly():
    repo_root = Path(__file__).resolve().parents[3]
    paths = [
        repo_root / "app/services/execution/schedule_helper.py",
        repo_root / "app/services/execution/dispatcher.py",
        repo_root / "app/api/endpoints/internal/callback.py",
    ]

    violations = []
    for path in paths:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if _is_disallowed_select(node) or _is_disallowed_query(node):
                violations.append(f"{path.relative_to(repo_root)}:{node.lineno}")

    assert violations == []


def _is_disallowed_select(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    if not isinstance(node.func, ast.Name) or node.func.id != "select":
        return False
    return any(_is_task_or_subtask_model(arg) for arg in node.args)


def _is_disallowed_query(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    if not isinstance(node.func, ast.Attribute) or node.func.attr != "query":
        return False
    return any(_is_task_or_subtask_model(arg) for arg in node.args)


def _is_task_or_subtask_model(node: ast.AST) -> bool:
    return isinstance(node, ast.Name) and node.id in {"TaskResource", "Subtask"}


@pytest.mark.asyncio
@pytest.mark.parametrize("storage", ["sharded", "legacy"])
async def test_callback_uses_store_to_resolve_task_user_id(
    test_db,
    test_user,
    monkeypatch,
    storage,
):
    install_entrypoint_stores(monkeypatch)
    from app.api.endpoints.internal import callback

    if storage == "sharded":
        task_id_value = new_task_id(test_user.id, 1)
        subtask_id_value = new_subtask_id(test_user.id, 2)
        add_sharded_task(test_db, task_id_value=task_id_value, user_id=test_user.id)
    else:
        task_id_value = 21
        subtask_id_value = 22
        add_legacy_task(test_db, task_id_value=task_id_value, user_id=test_user.id)

    created_emitters = []

    class RecordingWebSocketEmitter:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            created_emitters.append(kwargs)

    class RecordingStatusEmitter:
        def __init__(self, wrapped, **kwargs):
            self.wrapped = wrapped
            self.kwargs = kwargs
            self.events = []

        async def emit(self, event):
            self.events.append(event)

        async def close(self):
            pass

    monkeypatch.setattr(callback, "WebSocketResultEmitter", RecordingWebSocketEmitter)
    monkeypatch.setattr(callback, "StatusUpdatingEmitter", RecordingStatusEmitter)
    monkeypatch.setattr(
        callback.session_manager,
        "publish_callback_event",
        lambda subtask_id, event: _noop_async(),
    )
    monkeypatch.setattr(callback, "_forward_event_to_channels", _noop_forward)

    response = await callback.handle_callback(
        callback.CallbackRequest(
            event_type=ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value,
            task_id=task_id_value,
            subtask_id=subtask_id_value,
            data={"delta": "hi", "offset": 0},
        ),
        db=test_db,
    )

    assert response.status == "ok"
    assert created_emitters == [
        {
            "task_id": task_id_value,
            "subtask_id": subtask_id_value,
            "user_id": test_user.id,
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("storage", ["sharded", "legacy"])
async def test_dispatcher_recovers_executor_and_updates_subtask(
    test_db,
    test_user,
    monkeypatch,
    storage,
):
    _, subtask_store = install_entrypoint_stores(monkeypatch)
    from app.services.execution import dispatcher as dispatcher_module

    if storage == "sharded":
        task_id_value = new_task_id(test_user.id, 3)
        subtask_id_value = new_subtask_id(test_user.id, 4)
        add_sharded_task(test_db, task_id_value=task_id_value, user_id=test_user.id)
        add_sharded_subtask(
            test_db,
            subtask_id_value=subtask_id_value,
            task_id_value=task_id_value,
            user_id=test_user.id,
            executor_deleted_at=True,
        )
    else:
        task_id_value = 41
        subtask_id_value = 42
        add_legacy_task(test_db, task_id_value=task_id_value, user_id=test_user.id)
        add_legacy_subtask(
            test_db,
            subtask_id_value=subtask_id_value,
            task_id_value=task_id_value,
            user_id=test_user.id,
            executor_deleted_at=True,
        )

    monkeypatch.setattr(dispatcher_module, "SessionLocal", lambda: test_db)

    async def recover(**kwargs):
        assert kwargs["subtask"].id == subtask_id_value
        assert kwargs["task"].id == task_id_value
        return {
            "executor_name": "executor-recovered",
            "executor_namespace": "default-recovered",
        }

    monkeypatch.setattr(dispatcher_module.recovery_service, "recover", recover)

    request = ExecutionRequest(
        task_id=task_id_value,
        subtask_id=subtask_id_value,
        bot=[{"shell_type": "ClaudeCode"}],
    )

    await ExecutionDispatcher()._recover_executor_if_needed(request)

    updated = subtask_store.get_by_id(test_db, subtask_id=subtask_id_value)
    assert updated.executor_name == "executor-recovered"
    assert updated.executor_namespace == "default-recovered"
    assert updated.executor_deleted_at is False
    assert request.executor_name == "executor-recovered"
    assert request.executor_namespace == "default-recovered"


@pytest.mark.asyncio
async def test_dispatcher_sets_device_executor_for_sharded_and_legacy_subtasks(
    test_db,
    test_user,
    monkeypatch,
):
    _, subtask_store = install_entrypoint_stores(monkeypatch)
    from app.services.execution import dispatcher as dispatcher_module

    task_id_value = new_task_id(test_user.id, 5)
    subtask_id_value = new_subtask_id(test_user.id, 6)
    add_sharded_subtask(
        test_db,
        subtask_id_value=subtask_id_value,
        task_id_value=task_id_value,
        user_id=test_user.id,
    )
    legacy_subtask = add_legacy_subtask(
        test_db,
        subtask_id_value=61,
        task_id_value=51,
        user_id=test_user.id,
    )
    monkeypatch.setattr(dispatcher_module, "SessionLocal", lambda: test_db)

    dispatcher = ExecutionDispatcher()
    await dispatcher._set_subtask_executor(subtask_id_value, "device-a", test_user.id)
    await dispatcher._set_subtask_executor(legacy_subtask.id, "device-b", test_user.id)

    sharded = subtask_store.get_by_id(test_db, subtask_id=subtask_id_value)
    legacy = subtask_store.get_by_id(test_db, subtask_id=legacy_subtask.id)
    assert sharded.executor_name == "device-device-a"
    assert sharded.executor_namespace == f"user-{test_user.id}"
    assert legacy.executor_name == "device-device-b"
    assert legacy.executor_namespace == f"user-{test_user.id}"


@pytest.mark.asyncio
@pytest.mark.parametrize("storage", ["sharded", "legacy"])
async def test_schedule_helper_dispatches_pending_subtasks_through_store(
    test_db,
    test_user,
    monkeypatch,
    storage,
):
    install_entrypoint_stores(monkeypatch)
    from app.api import dependencies
    from app.services.execution import dispatcher as dispatcher_module
    from app.services.execution import request_builder, schedule_helper
    from app.services.readers import kinds as kinds_module

    if storage == "sharded":
        task_id_value = new_task_id(test_user.id, 7)
        subtask_id_value = new_subtask_id(test_user.id, 8)
        add_sharded_task(test_db, task_id_value=task_id_value, user_id=test_user.id)
        add_sharded_subtask(
            test_db,
            subtask_id_value=subtask_id_value,
            task_id_value=task_id_value,
            user_id=test_user.id,
        )
    else:
        task_id_value = 71
        subtask_id_value = 72
        add_legacy_task(test_db, task_id_value=task_id_value, user_id=test_user.id)
        add_legacy_subtask(
            test_db,
            subtask_id_value=subtask_id_value,
            task_id_value=task_id_value,
            user_id=test_user.id,
        )

    dispatched = []

    def fake_get_db():
        yield test_db

    class FakeBuilder:
        def __init__(self, db):
            self.db = db

        def build(self, *, subtask, task, user, team, message):
            return ExecutionRequest(
                task_id=task.id,
                subtask_id=subtask.id,
                user_id=user.id,
                bot=[{"shell_type": "ClaudeCode"}],
                prompt=message,
            )

    class FakeDispatcher:
        async def dispatch(self, request, device_id=None):
            dispatched.append((request, device_id))

    monkeypatch.setattr(dependencies, "get_db", fake_get_db)
    monkeypatch.setattr(
        kinds_module.kindReader,
        "get_by_name_and_namespace",
        lambda *args, **kwargs: SimpleNamespace(id=11, name="agent", json={}),
    )
    monkeypatch.setattr(request_builder, "TaskRequestBuilder", FakeBuilder)
    monkeypatch.setattr(dispatcher_module, "execution_dispatcher", FakeDispatcher())

    await schedule_helper._dispatch_task_async(task_id_value)

    assert len(dispatched) == 1
    request, device_id = dispatched[0]
    assert request.task_id == task_id_value
    assert request.subtask_id == subtask_id_value
    assert request.user_id == test_user.id
    assert device_id is None


async def _noop_async():
    pass


async def _noop_forward(task_id: int, subtask_id: int, event):
    pass
