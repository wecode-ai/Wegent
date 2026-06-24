from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import pytest

import app.stores.tasks as task_stores
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from wecode.service.cloud_device_provider import CloudDeviceProvider
from wecode.service.evaluation import grading_monitor
from wecode.service.evaluation.grading_base import GradingResult, GradingStrategy
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


class ConcreteGradingStrategy(GradingStrategy):
    async def execute(self, ctx: Any) -> GradingResult:
        return GradingResult(success=True)


class RecordingSubtaskStore(ShardedSubtaskStore):
    def __init__(self, subtasks):
        super().__init__()
        self.subtasks = subtasks
        self.list_assistant_calls = []
        self.list_ordered_calls = []

    def list_assistant_by_task(self, db, *, task_id: int, owner_user_id=None):
        self.list_assistant_calls.append((task_id, owner_user_id))
        return self.subtasks

    def list_by_task_ordered(self, db, *, task_id: int, **kwargs):
        self.list_ordered_calls.append((task_id, kwargs))
        return []


@pytest.fixture(scope="module", autouse=True)
def create_shard_tables(test_engine):
    for uid in range(SHARD_COUNT):
        task_model_for_user(uid).__table__.create(bind=test_engine, checkfirst=True)
        subtask_model_for_task_id(new_task_id(uid, 0)).__table__.create(
            bind=test_engine,
            checkfirst=True,
        )


@pytest.fixture
def install_internal_service_stores(monkeypatch):
    task_store = ShardedTaskStore()
    subtask_store = ShardedSubtaskStore()
    monkeypatch.setattr(task_stores, "task_store", task_store)
    monkeypatch.setattr(task_stores, "subtask_store", subtask_store)
    return task_store, subtask_store


def new_task_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def new_subtask_id(user_id: int, sequence: int) -> int:
    return encode_user_scoped_id(
        (user_id & 0xFFFF) or SHARD_COUNT, SEQUENCE_BASE + sequence + 1
    )


def task_payload(title: str, status: str = "RUNNING") -> dict[str, Any]:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": title, "namespace": "default"},
        "spec": {
            "title": title,
            "prompt": "grade",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {"status": status, "progress": 100},
    }


def add_sharded_task(
    test_db,
    *,
    task_id_value: int,
    user_id: int,
    status: str = "RUNNING",
) -> TaskResource:
    model = task_model_for_task_id(task_id_value)
    task = model(
        id=task_id_value,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id_value}",
        namespace="default",
        json=task_payload(f"task-{task_id_value}", status),
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
    task_id_value: int,
    subtask_id_value: int,
    user_id: int,
    status: SubtaskStatus,
    result: dict[str, Any] | None = None,
    error_message: str = "",
):
    model = subtask_model_for_task_id(task_id_value)
    subtask = model(
        id=subtask_id_value,
        user_id=user_id,
        task_id=task_id_value,
        team_id=1,
        title="assistant",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="default",
        executor_name="executor",
        prompt="",
        status=status,
        progress=100,
        message_id=2,
        parent_id=1,
        error_message=error_message,
        result=result,
    )
    test_db.add(subtask)
    test_db.flush()
    return subtask


def test_internal_services_do_not_query_task_or_subtask_tables_directly():
    repo_root = Path(__file__).resolve().parents[3]
    paths = [
        repo_root / "wecode/service/cloud_device_provider.py",
        repo_root / "wecode/service/evaluation/grading_base.py",
        repo_root / "wecode/service/evaluation/grading_monitor.py",
    ]

    violations = []
    for path in paths:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if _is_disallowed_query(node):
                violations.append(f"{path.relative_to(repo_root)}:{node.lineno}")

    assert violations == []


def _is_disallowed_query(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    if not isinstance(node.func, ast.Attribute) or node.func.attr != "query":
        return False
    return any(_is_task_or_subtask_model(arg) for arg in node.args)


def _is_task_or_subtask_model(node: ast.AST) -> bool:
    return isinstance(node, ast.Name) and node.id in {"TaskResource", "Subtask"}


@pytest.mark.asyncio
async def test_cloud_device_slot_usage_reads_sharded_running_tasks(
    test_db,
    monkeypatch,
    install_internal_service_stores,
):
    task = add_sharded_task(
        test_db,
        task_id_value=new_task_id(user_id=42, sequence=1),
        user_id=42,
        status="RUNNING",
    )
    provider = CloudDeviceProvider()

    async def fake_online_info(user_id: int, device_id: str):
        return {"running_task_ids": [task.id]}

    monkeypatch.setattr(provider, "_get_online_info", fake_online_info)

    result = await provider.get_slot_usage(test_db, user_id=42, device_id="device-a")

    assert result["used"] == 1
    assert result["running_tasks"][0]["task_id"] == task.id
    assert result["running_tasks"][0]["title"] == f"task-{task.id}"


def test_grading_monitor_reads_sharded_task_and_latest_completed_subtask(
    test_db,
    install_internal_service_stores,
):
    task = add_sharded_task(
        test_db,
        task_id_value=new_task_id(user_id=43, sequence=1),
        user_id=43,
        status="COMPLETED",
    )
    add_sharded_subtask(
        test_db,
        task_id_value=task.id,
        subtask_id_value=new_subtask_id(user_id=43, sequence=2),
        user_id=43,
        status=SubtaskStatus.COMPLETED,
        result={"value": "grading report"},
    )

    status, content = grading_monitor.GradingTaskMonitor().get_wegent_task_state(
        test_db, task.id
    )

    assert status == "COMPLETED"
    assert content == "grading report"


def test_grading_monitor_uses_assistant_store_boundary(test_db, monkeypatch):
    task = add_sharded_task(
        test_db,
        task_id_value=new_task_id(user_id=45, sequence=1),
        user_id=45,
        status="COMPLETED",
    )
    user_subtask = add_sharded_subtask(
        test_db,
        task_id_value=task.id,
        subtask_id_value=new_subtask_id(user_id=45, sequence=2),
        user_id=45,
        status=SubtaskStatus.COMPLETED,
        result={"value": "ignored"},
    )
    user_subtask.role = SubtaskRole.USER
    assistant_subtask = add_sharded_subtask(
        test_db,
        task_id_value=task.id,
        subtask_id_value=new_subtask_id(user_id=45, sequence=3),
        user_id=45,
        status=SubtaskStatus.COMPLETED,
        result={"value": "assistant report"},
    )
    store = RecordingSubtaskStore([assistant_subtask])
    monkeypatch.setattr(task_stores, "task_store", ShardedTaskStore())
    monkeypatch.setattr(task_stores, "subtask_store", store)

    status, content = grading_monitor.GradingTaskMonitor().get_wegent_task_state(
        test_db, task.id
    )

    assert status == "COMPLETED"
    assert content == "assistant report"
    assert store.list_assistant_calls == [(task.id, None)]
    assert store.list_ordered_calls == []


@pytest.mark.asyncio
async def test_grading_strategy_wait_reads_sharded_subtask_completion(
    test_db,
    install_internal_service_stores,
):
    task = add_sharded_task(
        test_db,
        task_id_value=new_task_id(user_id=44, sequence=1),
        user_id=44,
        status="RUNNING",
    )
    subtask = add_sharded_subtask(
        test_db,
        task_id_value=task.id,
        subtask_id_value=new_subtask_id(user_id=44, sequence=2),
        user_id=44,
        status=SubtaskStatus.COMPLETED,
        result={"value": "done"},
    )

    content, error = await ConcreteGradingStrategy()._wait_for_subtask_completion(
        test_db,
        assistant_subtask_id=subtask.id,
        timeout=1,
        poll_interval=1,
    )

    assert content == "done"
    assert error is None
