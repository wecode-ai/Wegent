# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import uuid
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
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


def test_device_pull_claims_and_fences_cloud_execution(
    test_db: Session,
    test_user: User,
) -> None:
    from app.services.loop_item_executions.device_pull import _claim_cloud_execution

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
            "loop_item_execution_service.build_runtime_payload",
            return_value={
                "executionRequest": {
                    "prompt": "Build the calculator.",
                }
            },
        ),
    ):
        result = _claim_cloud_execution(
            owner_user_id=test_user.id,
            device_id="cloud-device",
            runtime_instance_id="runtime-1",
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
    assert not loop_datetime_value_is_unset(execution.start_requested_at)


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
        patch(
            "app.tasks.robot_queue_tasks.device_service.get_device_online_info",
            AsyncMock(return_value={"socket_id": "socket-1"}),
        ),
        patch("app.core.socketio.get_sio", return_value=sio),
    ):
        await consume_queues_background()

    sio.emit.assert_awaited_once_with(
        "runtime.tasks.available",
        {},
        to="socket-1",
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
