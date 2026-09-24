# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import uuid
from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectChatAgent,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.user import User
from app.services.device.capacity import RuntimeCapacity
from app.services.loop_item_executions.service import loop_item_execution_service


def _make_execution(db: Session, user: User):
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"PULL{uuid.uuid4().hex[:6].upper()}",
        name="Pull project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    agent = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Pull Bot",
        name="Pull Bot",
        status="active",
        created_by_user_id=user.id,
        device_id="cloud-device",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "execution_mode": "auto",
            "execution_environment": "cloud",
        },
    )
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Run me",
        description="Build the calculator.",
        status="inbox",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add_all([agent, item])
    db.add(
        Kind(
            kind="Device",
            name="cloud-device",
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
        execution_device_id="cloud-device",
        priority="medium",
    )
    db.commit()
    return execution


def test_device_pull_claims_without_recording_unconfirmed_delivery(
    test_db: Session,
    test_user: User,
) -> None:
    from app.services.loop_item_executions.device_pull import _claim_execution

    execution = _make_execution(test_db, test_user)

    @contextmanager
    def _test_session():
        yield test_db

    with (
        patch(
            "app.services.loop_item_executions.device_pull.get_db_session",
            _test_session,
        ),
        patch(
            "app.services.loop_item_executions.device_pull."
            "validate_runtime_capacity_observation_sync",
            return_value=RuntimeCapacity(
                runtime_instance_id="runtime-1",
                limit=1,
                active=0,
                active_task_ids=frozenset(),
                queued=0,
            ),
        ),
        patch(
            "app.services.loop_item_executions.device_pull."
            "loop_item_execution_service.build_executor_runtime_payload",
            return_value={
                "executionRequest": {
                    "prompt": "Build the calculator.",
                }
            },
        ),
    ):
        result = _claim_execution(
            owner_user_id=test_user.id,
            execution_target_id="cloud-device",
            runtime_device_id="cloud-device",
            runtime_instance_id="runtime-1",
            environment="cloud",
            runtime_capacity={
                "limit": 1,
                "active": 0,
                "active_task_ids": [],
                "queued": 0,
            },
        )

    assert result["success"] is True
    assert result["task"]["execution_id"] == execution.id
    assert result["task"]["runtime_task_id"] == f"codex-queue-{execution.id}"
    test_db.refresh(execution)
    assert execution.status == "claimed"
    assert loop_datetime_value_is_unset(execution.start_requested_at)
    binding = (
        test_db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == execution.loop_item_id,
            LoopItemTaskBinding.task_id == f"codex-queue-{execution.id}",
        )
        .one()
    )
    assert binding.device_id == "cloud-device"


def test_device_pull_records_delivery_only_after_runtime_acceptance(
    test_db: Session,
    test_user: User,
) -> None:
    from app.services.loop_item_executions.device_pull import (
        _claim_execution,
        acknowledge_execution,
    )

    execution = _make_execution(test_db, test_user)

    @contextmanager
    def _test_session():
        yield test_db

    with (
        patch(
            "app.services.loop_item_executions.device_pull.get_db_session",
            _test_session,
        ),
        patch(
            "app.services.loop_item_executions.device_pull."
            "validate_runtime_capacity_observation_sync",
            return_value=RuntimeCapacity(
                runtime_instance_id="runtime-1",
                limit=1,
                active=0,
                active_task_ids=frozenset(),
                queued=0,
            ),
        ),
        patch(
            "app.services.loop_item_executions.device_pull."
            "loop_item_execution_service.build_executor_runtime_payload",
            return_value={
                "executionRequest": {
                    "prompt": "Build the calculator.",
                }
            },
        ),
    ):
        pulled = _claim_execution(
            owner_user_id=test_user.id,
            execution_target_id="cloud-device",
            runtime_device_id="cloud-device",
            runtime_instance_id="runtime-1",
            environment="cloud",
            runtime_capacity={
                "limit": 1,
                "active": 0,
                "active_task_ids": [],
                "queued": 0,
            },
        )
        test_db.refresh(execution)
        assert loop_datetime_value_is_unset(execution.start_requested_at)

        acknowledged = acknowledge_execution(
            owner_user_id=test_user.id,
            runtime_device_id="cloud-device",
            runtime_instance_id="runtime-1",
            execution_id=execution.id,
            runtime_task_id=pulled["task"]["runtime_task_id"],
            accepted=True,
            prompt=pulled["task"]["prompt"],
            error=None,
        )

    assert acknowledged == {"success": True}
    test_db.refresh(execution)
    assert not loop_datetime_value_is_unset(execution.start_requested_at)
    assert execution.observed_state == "accepted"


def test_device_pull_redelivers_same_unconfirmed_claim_before_new_work(
    test_db: Session,
    test_user: User,
) -> None:
    from app.services.loop_item_executions.device_pull import _claim_execution

    first = _make_execution(test_db, test_user)
    first_item = test_db.get(LoopItem, first.loop_item_id)
    first_agent = test_db.get(ProjectChatAgent, first.agent_id)
    assert first_item is not None
    assert first_agent is not None
    second_item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=first_item.cloud_project_id,
        title="Run me second",
        description="Build the calculator again.",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(second_item)
    test_db.commit()
    second = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=second_item.id,
        cloud_project_id=second_item.cloud_project_id,
        agent=first_agent,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device",
        priority="medium",
    )
    test_db.commit()

    @contextmanager
    def _test_session():
        yield test_db

    capacity = RuntimeCapacity(
        runtime_instance_id="runtime-1",
        limit=1,
        active=0,
        active_task_ids=frozenset(),
        queued=0,
    )
    with (
        patch(
            "app.services.loop_item_executions.device_pull.get_db_session",
            _test_session,
        ),
        patch(
            "app.services.loop_item_executions.device_pull."
            "validate_runtime_capacity_observation_sync",
            return_value=capacity,
        ),
        patch(
            "app.services.loop_item_executions.device_pull."
            "loop_item_execution_service.build_executor_runtime_payload",
            side_effect=lambda _db, execution, **_kwargs: {
                "executionRequest": {"prompt": execution.loop_item_id}
            },
        ),
    ):
        first_pull = _claim_execution(
            owner_user_id=test_user.id,
            execution_target_id="cloud-device",
            runtime_device_id="cloud-device",
            runtime_instance_id="runtime-1",
            environment="cloud",
            runtime_capacity=None,
        )
        repeated_pull = _claim_execution(
            owner_user_id=test_user.id,
            execution_target_id="cloud-device",
            runtime_device_id="cloud-device",
            runtime_instance_id="runtime-1",
            environment="cloud",
            runtime_capacity=None,
        )

    assert first_pull["task"]["execution_id"] == first.id
    assert repeated_pull["task"]["execution_id"] == first.id
    assert (
        repeated_pull["task"]["runtime_task_id"]
        == first_pull["task"]["runtime_task_id"]
    )
    test_db.refresh(first)
    test_db.refresh(second)
    assert first.status == "claimed"
    assert loop_datetime_value_is_unset(first.start_requested_at)
    assert second.status == "queued"


def test_periodic_scan_does_not_dispatch_runtime_work(
    test_db: Session,
    monkeypatch,
) -> None:
    from app.core.config import settings
    from app.tasks.robot_queue_tasks import scan_robot_queue

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    @contextmanager
    def _test_session():
        yield test_db

    monkeypatch.setattr(settings, "ROBOT_QUEUE_SCHEDULER_ENABLED", True)
    with (
        patch("app.db.session.get_db_session", _test_session),
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service.recovery_scan",
            return_value=(2, 1),
        ),
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service.stall_scan",
            return_value=[],
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
    ):
        result = scan_robot_queue.run()

    assert result == {
        "status": "ok",
        "requeued": 2,
        "unknown": 1,
        "reconciled": 0,
        "stalled": 0,
    }


def test_periodic_scan_publishes_with_write_only_redis_manager(
    test_db: Session,
    test_user: User,
    monkeypatch,
) -> None:
    from app.core.config import settings
    from app.tasks.robot_queue_tasks import scan_robot_queue

    _make_execution(test_db, test_user)

    @contextmanager
    def _acquired(*args, **kwargs):
        yield True

    @contextmanager
    def _test_session():
        yield test_db

    manager = MagicMock()
    monkeypatch.setattr(settings, "ROBOT_QUEUE_SCHEDULER_ENABLED", True)
    with (
        patch("app.db.session.get_db_session", _test_session),
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service.recovery_scan",
            return_value=(0, 0),
        ),
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service.stall_scan",
            return_value=[],
        ),
        patch(
            "app.tasks.robot_queue_tasks.distributed_lock.acquire_context",
            _acquired,
        ),
        patch(
            "app.tasks.robot_queue_tasks.socketio.RedisManager",
            return_value=manager,
        ) as redis_manager,
    ):
        result = scan_robot_queue.run()

    assert result["status"] == "ok"
    redis_manager.assert_called_once_with(settings.REDIS_URL, write_only=True)
    manager.emit.assert_called_once_with(
        "runtime.tasks.available",
        {},
        room=f"execution-target:{test_user.id}:cloud-device",
        namespace="/local-executor",
    )


def test_stall_cancel_routes_managed_runs_to_the_chat_runtime() -> None:
    """A stalled managed Wegent run has no device Runtime to receive the cancel
    RPC, so the stop must travel through the managed Chat execution service.

    Regression: such a run was left in cancel_requested with nothing able to
    acknowledge the stop, so it held capacity forever.
    """

    from app.models.loop_item_execution import LoopItemExecution
    from app.tasks.robot_queue_tasks import emit_managed_cancels

    managed = LoopItemExecution(
        id=11,
        team_id=7,
        backend_task_id=4321,
        executor_owner_user_id=9,
        runtime_device_id="",
        runtime_task_id="",
    )
    device_run = LoopItemExecution(
        id=12,
        team_id=0,
        backend_task_id=0,
        executor_owner_user_id=9,
        runtime_device_id="cloud-device",
        runtime_task_id="codex-queue-12",
    )
    cancel = AsyncMock(return_value=True)

    with patch(
        "app.services.project_automation_managed_execution."
        "project_automation_managed_execution_service.cancel",
        cancel,
    ):
        cancelled = emit_managed_cancels([managed, device_run])

    assert cancelled == {11}
    cancel.assert_awaited_once_with(
        task_id=4321,
        user_id=9,
        source="board_team_assignment",
    )


def test_runtime_cancel_routes_through_execution_target() -> None:
    """A local Runtime may report a hardware ID that differs from its socket route."""

    from app.models.loop_item_execution import LoopItemExecution
    from app.tasks.robot_queue_tasks import emit_runtime_cancels

    execution = LoopItemExecution(
        id=13,
        executor_owner_user_id=9,
        execution_device_id="app-record-65",
        runtime_device_id="electron-runtime-device",
        runtime_task_id="codex-queue-13",
    )
    response = MagicMock(status_code=200)
    response.json.return_value = {"emitted": True, "accepted": True}
    client = MagicMock()
    client.__enter__.return_value = client
    client.post.return_value = response

    @contextmanager
    def _test_session():
        yield MagicMock()

    with (
        patch("httpx.Client", return_value=client),
        patch("app.db.session.get_db_session", _test_session),
        patch(
            "app.tasks.robot_queue_tasks.loop_item_execution_service."
            "confirm_runtime_cancelled"
        ) as confirm_runtime_cancelled,
    ):
        cancelled = emit_runtime_cancels([execution])

    assert cancelled == {13}
    client.post.assert_called_once()
    assert client.post.call_args.kwargs["json"] == {
        "user_id": 9,
        "device_id": "app-record-65",
        "method": "runtime.tasks.cancel",
        "payload": {
            "taskId": "codex-queue-13",
            "deviceId": "electron-runtime-device",
        },
        "wait_ack": True,
        "ack_timeout_seconds": 15,
    }
    confirm_runtime_cancelled.assert_called_once()
    assert confirm_runtime_cancelled.call_args.kwargs["execution_id"] == 13


async def test_queue_wakeup_only_emits_availability(
    test_db: Session,
    test_user: User,
) -> None:
    from app.tasks.robot_queue_tasks import consume_queues_background

    _make_execution(test_db, test_user)

    @contextmanager
    def _test_session():
        yield test_db

    sio = AsyncMock()
    with (
        patch("app.db.session.get_db_session", _test_session),
        patch("app.core.socketio.get_sio", return_value=sio),
    ):
        await consume_queues_background()

    sio.emit.assert_awaited_once_with(
        "runtime.tasks.available",
        {},
        room=f"execution-target:{test_user.id}:cloud-device",
        namespace="/local-executor",
    )


async def test_heartbeat_reconciliation_queries_only_unconfirmed_executions(
    test_db: Session,
) -> None:
    from app.tasks.robot_queue_tasks import reconcile_device_executions

    @contextmanager
    def _test_session():
        yield test_db

    with (
        patch("app.db.session.get_db_session", _test_session),
        patch.object(
            loop_item_execution_service,
            "active_for_device_reconciliation",
            return_value=[],
        ) as active_for_device,
        patch("app.core.socketio.get_sio") as get_sio,
    ):
        reconciled = await reconcile_device_executions(
            user_id=7,
            device_id="cloud-device",
            needs_confirmation_only=True,
        )

    assert reconciled == 0
    active_for_device.assert_called_once_with(
        test_db,
        owner_user_id=7,
        runtime_device_id="cloud-device",
        needs_confirmation_only=True,
    )
    get_sio.assert_not_called()
