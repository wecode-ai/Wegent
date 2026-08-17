# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for the cloud Wework execution dispatcher."""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.device.capacity import RuntimeCapacity
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
    monkeypatch.setattr(
        loop_item_execution_service,
        "_materialize_backend_request",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        "app.services.chat.trigger.unified.build_wework_runtime_model_config",
        lambda *_args, **_kwargs: {"model_id": "test-model"},
    )
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.get_runtime_capacity",
        AsyncMock(
            return_value=RuntimeCapacity(
                runtime_instance_id="runtime-1",
                limit=1,
                active=0,
                active_task_ids=frozenset(),
                queued=0,
            )
        ),
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
            "execution_environment": "cloud",
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
    device = (
        db.query(Kind)
        .filter(
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == "local-device",
            Kind.user_id == user.id,
            Kind.is_active == True,
        )
        .first()
    )
    if device is None:
        db.add(
            Kind(
                kind="Device",
                name="local-device",
                namespace="default",
                user_id=user.id,
                is_active=True,
                json={"spec": {"deviceType": "cloud"}},
            )
        )
        db.commit()
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        agent=agent,
        assigner_user_id=user.id,
        environment="cloud",
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
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    execution = claimed

    emit_rpc = AsyncMock(return_value={"emitted": True})
    with patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc):
        import asyncio

        asyncio.run(_dispatch_execution(test_db, execution))

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
    assert payload["message"] == (
        f"project_id: {project.id}\n"
        f"task_id: {execution.loop_item_id}\n"
        f"execution_id: {execution.id}\n\n"
        f"看板任务数据位于 cloud://projects/{project.id}/todos/"
        f"{execution.loop_item_id}，请通过看板工具自行查看。\n\n"
        "Verify before reporting."
    )
    assert "Build the landing page" not in payload["message"]
    assert "system_prompt" not in payload["executionRequest"]
    assert "system_prompt" not in payload["executionRequest"]["bot"][0]
    assert payload["additionalContext"] == {}
    assert payload["executionRequest"]["mcp_servers"] == []

    test_db.refresh(execution)
    assert execution.runtime_device_id == "local-device"
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"
    assert execution.status == "claimed"
    assert not loop_datetime_value_is_unset(execution.start_requested_at)


def test_dispatch_first_terminal_event_does_not_reopen_completed_activity(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=execution.loop_item_id,
        title="Fast automation run",
        description="",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.flush()
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=execution.loop_item_id,
        sender_type="agent",
        sender_id=agent.id,
        sender_name=agent.title,
        message_type="agent_status",
        content="",
        metadata_json={
            "automation_run_id": str(run.id),
            "execution_id": execution.id,
            "executor_type": "project_robot",
            "run_status": "queued",
        },
        agent_id=agent.id,
        status="pending",
    )
    run.metadata_json = {"activity_message_id": message_id}
    execution.automation_run_id = str(run.id)
    test_db.add(activity)
    test_db.commit()

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id="local-device",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.wait_for_run_event",
        lambda *args, **kwargs: "response.completed",
    )

    async def emit_terminal_event(**kwargs):
        runtime_task_id = kwargs["payload"]["taskId"]
        completed = loop_item_execution_service.handle_runtime_event(
            test_db,
            device_id="local-device",
            runtime_task_id=runtime_task_id,
            event_name="response.completed",
            payload={"eventSeq": 1, "data": {"value": "Finished immediately"}},
        )
        assert completed is not None and completed.status == "completed"
        return {"emitted": True}

    with (
        patch(
            "app.tasks.robot_queue_tasks._emit_runtime_rpc",
            AsyncMock(side_effect=emit_terminal_event),
        ),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            AsyncMock(return_value=True),
        ),
    ):
        import asyncio

        asyncio.run(_dispatch_execution(test_db, claimed))

    test_db.refresh(claimed)
    test_db.refresh(run)
    test_db.refresh(activity)
    assert claimed.status == "completed"
    assert run.status == "succeeded"
    assert activity.status == "completed"
    assert activity.content == "Finished immediately"
    assert activity.metadata_json["run_status"] == "completed"


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
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
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


def test_dispatch_execution_rejects_explicit_foreign_routing_owner(
    test_db: Session, test_user: User
) -> None:
    """Even internal callers cannot override the execution's persisted owner."""

    import asyncio

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=agent.id,
        execution_device_id="local-device",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None

    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", AsyncMock()) as emit_rpc,
        pytest.raises(RuntimeError, match="another device owner"),
    ):
        asyncio.run(
            _dispatch_execution(
                test_db,
                claimed,
                routing_user_id=test_user.id + 1000,
            )
        )

    emit_rpc.assert_not_awaited()


def test_consumer_claims_cloud_and_leaves_local_for_app_claim(
    test_db: Session, test_user: User
) -> None:
    """The canonical consumer claims cloud runs and ignores local App work."""

    import asyncio
    from contextlib import contextmanager

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    local_execution = _make_execution(test_db, project, agent, test_user)
    local_execution.execution_environment = "local"
    test_db.commit()
    cloud_execution = _make_execution(test_db, project, agent, test_user)

    lock_names: list[str] = []

    @contextmanager
    def _acquired(name: str, **kwargs):
        lock_names.append(name)
        yield True

    enqueue = MagicMock()
    with (
        patch(
            "app.tasks.robot_queue_tasks._device_online", AsyncMock(return_value=True)
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
        patch("app.tasks.robot_queue_tasks.execute_robot_task.apply_async", enqueue),
    ):
        from app.tasks.robot_queue_tasks import _consumer_pass

        handled = asyncio.run(_consumer_pass(test_db))

    assert handled == 1
    enqueue.assert_called_once_with(args=[cloud_execution.id])
    assert lock_names == [
        f"robot_exec_owner:{test_user.id}",
        f"robot_exec:{test_user.id}:runtime:runtime-1",
    ]

    test_db.refresh(local_execution)
    test_db.refresh(cloud_execution)
    assert local_execution.status == "queued"
    assert cloud_execution.status == "claimed"
    assert local_execution.runtime_device_id == ""
    assert cloud_execution.runtime_task_id == f"codex-queue-{cloud_execution.id}"


def test_periodic_scan_only_recovers_and_publishes_metrics(
    test_db: Session, monkeypatch
) -> None:
    """The periodic scan must not become a second queue consumer."""

    from contextlib import contextmanager

    from app.core.config import settings
    from app.tasks.robot_queue_tasks import scan_robot_queue

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    @contextmanager
    def _test_session():
        yield test_db

    monkeypatch.setattr(settings, "ROBOT_QUEUE_SCHEDULER_ENABLED", True)
    consume = AsyncMock()
    enqueue = MagicMock()
    with (
        patch("app.db.session.get_db_session", _test_session),
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service.recovery_scan",
            return_value=(2, 1),
        ) as recovery,
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service.stall_scan",
            return_value=[],
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
        patch("app.tasks.robot_queue_tasks._consumer_pass", consume),
        patch("app.tasks.robot_queue_tasks.execute_robot_task.apply_async", enqueue),
    ):
        result = scan_robot_queue.run()

    assert result == {
        "status": "ok",
        "requeued": 2,
        "unknown": 1,
        "reconciled": 0,
        "stalled": 0,
    }
    recovery.assert_called_once_with(test_db)
    consume.assert_not_awaited()
    enqueue.assert_not_called()


def test_two_owners_with_same_cloud_device_get_independent_capacity_and_routes(
    test_db: Session, test_user: User
) -> None:
    """Queue identity and capacity are scoped by owner, environment, and device."""

    import asyncio
    from contextlib import contextmanager

    other = User(
        user_name=f"other-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        email=f"other-{uuid.uuid4().hex[:8]}@example.com",
        is_active=True,
    )
    test_db.add(other)
    test_db.commit()
    test_db.refresh(other)

    first_project = _make_project(test_db, test_user)
    first_agent = _make_agent(test_db, first_project, test_user)
    first = _make_execution(test_db, first_project, first_agent, test_user)
    second_project = _make_project(test_db, other)
    second_agent = _make_agent(test_db, second_project, other)
    second = _make_execution(test_db, second_project, second_agent, other)

    lock_names: list[str] = []

    @contextmanager
    def _acquired(name: str, **kwargs):
        lock_names.append(name)
        yield True

    online = AsyncMock(return_value=True)
    enqueue = MagicMock()
    with (
        patch("app.tasks.robot_queue_tasks._device_online", online),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
        patch("app.tasks.robot_queue_tasks.execute_robot_task.apply_async", enqueue),
    ):
        from app.tasks.robot_queue_tasks import _consumer_pass

        handled = asyncio.run(_consumer_pass(test_db))

    assert handled == 2
    assert {tuple(entry.kwargs["args"]) for entry in enqueue.call_args_list} == {
        (first.id,),
        (second.id,),
    }
    assert {tuple(entry.args) for entry in online.await_args_list} == {
        (test_user.id, "local-device"),
        (other.id, "local-device"),
    }
    assert set(lock_names) == {
        f"robot_exec_owner:{test_user.id}",
        f"robot_exec_owner:{other.id}",
        f"robot_exec:{test_user.id}:runtime:runtime-1",
        f"robot_exec:{other.id}:runtime:runtime-1",
    }
    test_db.refresh(first)
    test_db.refresh(second)
    assert first.status == "claimed"
    assert second.status == "claimed"


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
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
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
    assert execution.status == "claimed"
    assert not loop_datetime_value_is_unset(execution.start_requested_at)
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
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
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
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
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

    assert result["status"] == "requeued"
    assert result["reason"] == "device_emit_rejected"
    test_db.refresh(claimed[0])
    assert claimed[0].status == "queued"
    assert claimed[0].retry_attempt == 0
    assert claimed[0].execution_note == "device_emit_rejected"
    assert "Device did not accept the runtime RPC" in claimed[0].error_message


def test_execute_robot_task_keeps_ambiguous_emit_outcome_unknown(
    test_db: Session, test_user: User
) -> None:
    from contextlib import contextmanager

    from app.tasks.robot_queue_tasks import execute_robot_task

    @contextmanager
    def _test_session():
        yield test_db

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    _make_execution(test_db, project, agent, test_user)
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="local-device",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=1,
    )[0]
    emit_rpc = AsyncMock(return_value={"emitted": False, "outcome_unknown": True})
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            AsyncMock(return_value=True),
        ),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed.id)

    assert result["status"] == "unknown"
    test_db.refresh(claimed)
    assert claimed.status == "claimed"
    assert claimed.sync_state == "stale"
    assert not loop_datetime_value_is_unset(claimed.start_requested_at)


@pytest.mark.asyncio
async def test_stale_reconciliation_uses_runtime_turn_status(test_db: Session) -> None:
    from app.tasks.robot_queue_tasks import _reconcile_stale_executions

    execution = MagicMock(
        id=42,
        executor_owner_user_id=7,
        runtime_device_id="local-device",
        runtime_task_id="codex-queue-42",
    )
    response = {
        "accepted": True,
        "response": {
            "workspaces": [
                {
                    "tasks": [
                        {
                            "taskId": "codex-queue-42",
                            "status": "active",
                            "running": False,
                            "turnStatus": "completed",
                        }
                    ]
                }
            ]
        },
    }
    with (
        patch.object(
            loop_item_execution_service,
            "stale_for_reconciliation",
            return_value=[execution],
        ),
        patch(
            "app.tasks.robot_queue_tasks._emit_runtime_rpc",
            AsyncMock(return_value=response),
        ),
        patch.object(
            loop_item_execution_service,
            "reconcile_runtime_snapshot",
        ) as reconcile,
    ):
        count = await _reconcile_stale_executions(test_db)

    assert count == 1
    reconcile.assert_called_once_with(
        test_db,
        execution_id=42,
        runtime_status="active",
        running=False,
        turn_status="completed",
    )


def test_execute_robot_task_requeues_offline_without_consuming_retries(
    test_db: Session, test_user: User
) -> None:
    """A device that drops between claim and dispatch must stay queued for the
    next scan instead of terminally failing after the configured retries."""

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
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=1,
    )
    assert len(claimed) == 1

    capacity = AsyncMock(return_value=None)
    emit_rpc = AsyncMock(return_value={"emitted": True})
    with (
        patch("app.tasks.robot_queue_tasks._emit_runtime_rpc", emit_rpc),
        patch("app.tasks.robot_queue_tasks.get_runtime_capacity", capacity),
        patch("app.db.session.get_db_session", _test_session),
    ):
        result = execute_robot_task(claimed[0].id)

    assert result["status"] == "requeued"
    assert result["reason"] == "device_offline"
    emit_rpc.assert_not_awaited()
    test_db.refresh(claimed[0])
    assert claimed[0].status == "queued"
    assert claimed[0].retry_attempt == 0
    assert claimed[0].execution_note == "device_offline"
    assert "capacity observation expired before dispatch" in claimed[0].error_message


def test_cloud_dispatch_never_uses_another_users_shared_device(
    test_db: Session, test_user: User
) -> None:
    """An online same-named stranger cannot satisfy the execution owner's route."""

    import asyncio
    from contextlib import contextmanager

    other = User(
        user_name=f"other-device-owner-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        email=f"other-device-owner-{uuid.uuid4().hex[:8]}@example.com",
        is_active=True,
    )
    test_db.add(other)
    test_db.commit()
    test_db.refresh(other)
    # The stranger's Device row is inserted first; a global first() lookup
    # would resolve to this user.
    test_db.add(
        Kind(
            kind="Device",
            name="local-device",
            namespace="default",
            user_id=other.id,
            is_active=True,
            json={},
        )
    )
    test_db.commit()

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)

    async def online(user_id: int, device_id: str):
        # Only the stranger's device is online; the creator's is offline.
        return user_id == other.id

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    enqueue = MagicMock()
    with (
        patch(
            "app.tasks.robot_queue_tasks._device_online", side_effect=online
        ) as check,
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
        patch("app.tasks.robot_queue_tasks.execute_robot_task.apply_async", enqueue),
    ):
        from app.tasks.robot_queue_tasks import _consumer_pass

        handled = asyncio.run(_consumer_pass(test_db))

    assert handled == 0
    enqueue.assert_not_called()
    check.assert_awaited_once_with(test_user.id, "local-device")
    test_db.refresh(execution)
    assert execution.status == "queued"


def test_emit_runtime_rpc_uses_configured_internal_url(monkeypatch) -> None:
    """The internal emit must use BACKEND_INTERNAL_URL, never a hardcoded
    localhost port; production pods listen on a different port than dev."""

    import asyncio

    import httpx

    from app.tasks.robot_queue_tasks import _emit_runtime_rpc

    captured: dict[str, object] = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {"emitted": True}

    class FakeClient:
        def __init__(self, **kwargs):
            captured["base_url"] = kwargs["base_url"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path: str, **kwargs):
            captured["path"] = path
            captured["headers"] = kwargs["headers"]
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(
        settings, "BACKEND_INTERNAL_URL", "https://internal.example.com/api"
    )
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "internal-test-token")

    result = asyncio.run(
        _emit_runtime_rpc(
            user_id=86,
            device_id="local-device",
            method="runtime.tasks.create",
            payload={"taskId": "codex-queue-1"},
        )
    )

    assert result == {"emitted": True}
    assert captured["base_url"] == "https://internal.example.com/api"
    assert captured["path"] == "/internal/robot-queue/emit-runtime-rpc"
    assert captured["headers"] == {"Authorization": "Bearer internal-test-token"}


def test_loop_item_response_exposes_terminal_execution_error(
    test_db: Session, test_user: User
) -> None:
    """Task detail responses must keep the newest run visible after it fails,
    including its error message, so the UI can show why execution stopped."""

    from app.services.loop_items.service import loop_item_service

    project = _make_project(test_db, test_user)
    agent = _make_agent(test_db, project, test_user)
    execution = _make_execution(test_db, project, agent, test_user)
    loop_item_execution_service.fail(
        test_db,
        execution_id=execution.id,
        error="Device went offline before dispatch",
        requeue_infra=True,
    )

    values = loop_item_service.response_values(
        test_db, test_db.get(LoopItem, execution.loop_item_id), test_user.id
    )

    assert values["execution_id"] == execution.id
    assert values["execution_state"] == "queued"
    assert values["execution_error"] == "Device went offline before dispatch"
