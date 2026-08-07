# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for the unified robot queue dispatcher."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)
from app.tasks.robot_queue_tasks import _dispatch_execution


@pytest.fixture(autouse=True)
def _fake_run_event_wait(monkeypatch):
    """Keep dispatch tests off the real Redis run-event channel."""

    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.wait_for_run_event",
        lambda *args, **kwargs: "response.created",
    )


def _make_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"DISP{uuid.uuid4().hex[:6].upper()}",
        name="Dispatch project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_agent(db: Session, project: CloudProject, user: User) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Dispatch Bot",
        name="Dispatch Bot",
        status="active",
        created_by_user_id=user.id,
        device_id="local-device",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "system_prompt": "Verify before reporting.",
            "execution_mode": "auto",
            "execution_environment": "local",
            "visibility": "public",
        },
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


def _make_execution(
    db: Session, project: CloudProject, agent: ProjectChatAgent, user: User
) -> LoopItemExecution:
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Run me",
        description="Build the landing page.",
        status="inbox",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        agent=agent,
        assigner_user_id=user.id,
        environment="local",
        execution_device_id="local-device",
        priority="medium",
    )
    db.commit()
    db.refresh(execution)
    return execution


def test_dispatch_execution_uses_app_codex_channel_and_writes_back_ids(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id="local-device",
        environment="local",
    )
    assert claimed is not None
    execution = claimed

    emit_rpc = AsyncMock(return_value={"emitted": True})
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
    ):
        import asyncio

        asyncio.run(_dispatch_execution(test_db, execution))

    assert online.await_count == 1
    emit_rpc.assert_awaited_once()
    kwargs = emit_rpc.await_args.kwargs
    assert kwargs["method"] == "runtime.tasks.create"
    assert kwargs["device_id"] == "local-device"
    payload = kwargs["payload"]
    assert payload["taskId"] == f"codex-queue-{execution.id}"
    assert payload["executionRequest"]["task_id"] == f"codex-queue-{execution.id}"
    assert payload["executionRequest"]["subtask_id"] == (
        f"codex-queue-{execution.id}-assistant"
    )
    assert payload["message"]
    # The message is the robot role description; the AI reads the task itself
    # through wework_space instead of receiving the task content inline.
    assert "你是 Dispatch Bot，这个项目任务的 AI 执行者。" in payload["message"]
    assert "Verify before reporting." in payload["message"]
    assert "Build the landing page" not in payload["message"]
    assert "get_board_item" in payload["additionalContext"]["projectChat"]["value"]

    test_db.refresh(execution)
    assert execution.runtime_device_id == "local-device"
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"
    assert execution.status == "running"


def test_dispatch_execution_fails_when_executor_never_starts_session(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    """A dispatched run whose executor never starts a codex session must raise
    before any streaming comment is created, so the run never shows a fake
    "AI 执行" card.

    Regression: the emit was fire-and-forget with no acceptance signal, so an
    executor that never started the task still produced a running execution
    and an empty streaming message ("只创建评论、不创建会话").
    """

    from app.services.project_chat.service import project_chat_service

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id="local-device",
        environment="local",
    )
    assert claimed is not None

    emit_rpc = AsyncMock(return_value={"emitted": True})
    online = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.wait_for_run_event",
        lambda *args, **kwargs: None,
    )
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
    ):
        import asyncio

        with pytest.raises(RuntimeError, match="did not start a codex session"):
            asyncio.run(_dispatch_execution(test_db, execution))

    # No streaming agent message may exist for the task.
    assert (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.task_id == claimed.loop_item_id,
            ProjectChatMessage.sender_type == "agent",
        )
        .count()
        == 0
    )


def test_queue_scan_dispatches_local_and_cloud_runs_through_same_internal_emit(
    test_db: Session, test_user: User
) -> None:
    """Local and cloud device runs must be pushed by the backend through the
    same internal runtime RPC channel; the App is not required to start them."""

    import asyncio
    from contextlib import contextmanager
    from unittest.mock import AsyncMock, patch

    project = _make_project(test_db, test_user)
    local_agent = _make_agent(test_db, project, test_user)
    local_execution = _make_execution(test_db, project, local_agent, test_user)

    cloud_agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Cloud Bot",
        name="Cloud Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="cloud-device-1",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "system_prompt": "Cloud verify.",
            "execution_mode": "auto",
            "execution_environment": "cloud",
            "visibility": "public",
        },
    )
    test_db.add(cloud_agent)
    test_db.commit()
    test_db.refresh(cloud_agent)
    cloud_execution = _make_execution(test_db, project, cloud_agent, test_user)
    cloud_execution.execution_environment = "cloud"
    cloud_execution.execution_device_id = "cloud-device-1"
    test_db.commit()

    emit_rpc = AsyncMock(return_value={"emitted": True, "accepted": True})
    online = AsyncMock(return_value=True)

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            online,
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
    ):
        from app.tasks.robot_queue_tasks import _dispatch_queued_executions

        asyncio.run(_dispatch_queued_executions(test_db))

    assert (
        emit_rpc.await_count == 2
    ), f"expected one emit per device, got {emit_rpc.await_count}"
    devices = {call.kwargs["device_id"] for call in emit_rpc.await_args_list}
    assert devices == {"local-device", "cloud-device-1"}

    test_db.refresh(local_execution)
    test_db.refresh(cloud_execution)
    assert local_execution.status == "running"
    assert cloud_execution.status == "running"
    assert local_execution.runtime_task_id == f"codex-queue-{local_execution.id}"
    assert cloud_execution.runtime_task_id == f"codex-queue-{cloud_execution.id}"


def test_queue_scan_falls_back_to_creator_online_when_device_owner_offline(
    test_db: Session, test_user: User
) -> None:
    """Dispatch must use the robot creator's identity when the Kind device
    owner is offline but the creator's App is online (mixed dev accounts)."""

    import asyncio
    from contextlib import contextmanager
    from unittest.mock import AsyncMock, patch

    owner = User(
        user_name="deviceowner",
        password_hash="x",
        email="owner@example.com",
        is_active=True,
    )
    test_db.add(owner)
    test_db.commit()
    test_db.refresh(owner)
    test_db.add(
        Kind(
            kind="Device",
            name="local-device",
            namespace="default",
            user_id=owner.id,
            is_active=True,
            json={},
        )
    )
    test_db.commit()

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)

    emit_rpc = AsyncMock(return_value={"emitted": True, "accepted": True})

    async def online(user_id: int, device_id: str):
        return user_id == test_user.id

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            side_effect=online,
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
    ):
        from app.tasks.robot_queue_tasks import _dispatch_queued_executions

        asyncio.run(_dispatch_queued_executions(test_db))

    assert emit_rpc.await_count == 1, "dispatch should still happen for creator"
    assert emit_rpc.await_args.kwargs["user_id"] == test_user.id
    test_db.refresh(execution)
    assert execution.status == "running"


def test_execute_robot_task_advances_claimed_and_dispatches(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1
    execution = claimed[0]

    emit_rpc = AsyncMock(
        return_value={
            "emitted": True,
            "accepted": True,
            "result": {"taskId": f"codex-queue-{execution.id}"},
        }
    )
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(execution.id)

    assert result["status"] == "dispatched"
    test_db.refresh(execution)
    assert execution.status == "running"
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"
    emit_rpc.assert_awaited_once()


def test_execute_robot_task_skips_reclaimed_execution(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1
    # The lease watchdog reclaimed it back to queued before the subtask ran.
    claimed[0].status = "queued"
    test_db.commit()

    emit_rpc = AsyncMock(return_value={"emitted": True})
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed[0].id)

    assert result["status"] == "skipped"
    emit_rpc.assert_not_awaited()


def test_execute_robot_task_fails_and_requeues(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        device_capacity=1,
    )
    assert len(claimed) == 1

    emit_rpc = AsyncMock(return_value={"emitted": False})
    online = AsyncMock(return_value=True)
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info", online
        ),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed[0].id)

    assert result["status"] == "failed"
    test_db.refresh(claimed[0])
    assert claimed[0].status == "queued"
    assert claimed[0].retry_attempt == 1
