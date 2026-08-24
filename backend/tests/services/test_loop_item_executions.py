# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for robot queue execution records (claim/capacity/lease)."""

import uuid
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import app.services.project_automation_execution as project_automation_execution_module
from app.db.base import Base
from app.models.cloud_project import LoopItemTaskBinding
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    ProjectWorkflowPlanItem,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.project_chat import LoopItemAssign
from app.services.board_team_execution import dispatch_board_robot_execution
from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.loop_item_executions.profile import WeworkExecutionProfile
from app.services.loop_item_executions.service import (
    TaskContext,
    WeworkRuntimeConfigurationError,
    execution_display_state,
    loop_item_execution_service,
)
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_automation_execution import project_automation_execution
from app.services.workflow_stage_context import workflow_stage_task_instruction


@pytest.fixture
def independent_session_database(tmp_path):
    """Provide committed rows visible to genuinely independent DB sessions."""

    engine = create_engine(f"sqlite:///{tmp_path / 'terminal-state.db'}")
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    setup = factory()
    user = User(
        user_name="terminal-state-user",
        password_hash="test-hash",
        email="terminal-state@example.com",
        is_active=True,
        git_info=None,
    )
    setup.add(user)
    setup.commit()
    setup.refresh(user)
    setup.expunge(user)
    setup.close()
    try:
        yield factory, user
    finally:
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def test_project_automation_activity_push_commits_before_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    run = MagicMock()
    row = MagicMock()
    db = MagicMock()
    db.flush.side_effect = lambda: events.append("flush")
    db.commit.side_effect = lambda: events.append("commit")
    monkeypatch.setattr(
        project_automation_execution_module.ProjectAutomationExecution,
        "_activity",
        staticmethod(lambda _db, _run: events.append("read") or row),
    )
    monkeypatch.setattr(
        project_automation_execution_module.project_chat_service,
        "to_view",
        lambda _row: MagicMock(
            model_dump=lambda **_kwargs: events.append("serialize")
            or {"id": "message-1"}
        ),
    )
    monkeypatch.setattr(
        project_automation_execution_module,
        "push_project_chat_message",
        lambda payload: events.append(("push", payload)),
    )

    project_automation_execution._commit_and_push_activity(db, run)

    assert events == [
        "flush",
        "read",
        "serialize",
        "commit",
        ("push", {"id": "message-1"}),
    ]


def _make_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"EXEC{uuid.uuid4().hex[:6].upper()}",
        name="Execution project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_bot(
    db: Session, project: CloudProject, user: User, *, mode: str = "auto"
) -> ProjectChatAgent:
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Execution Bot",
        name="Execution Bot",
        status="active",
        created_by_user_id=user.id,
        device_id="cloud-device-1",
        metadata_json={
            "runtime": "codex",
            "execution_mode": mode,
            "execution_environment": "cloud",
            "visibility": "public",
        },
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _make_wegent_bot(
    db: Session, project: CloudProject, user: User
) -> tuple[ProjectChatAgent, Kind]:
    team = Kind(
        kind="Team",
        name=f"board-team-{uuid.uuid4().hex[:8]}",
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={},
    )
    db.add(team)
    db.flush()
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Wegent Execution Bot",
        name="Wegent Execution Bot",
        status="active",
        created_by_user_id=user.id,
        device_id="",
        metadata_json={
            "runtime": "wegent",
            "wegent_team_id": team.id,
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    db.refresh(team)
    return bot, team


def _make_item(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    title: str = "Execution task",
    priority: str = "medium",
) -> LoopItem:
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title=title,
        description="",
        status="inbox",
        priority=priority,
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _ensure_device(
    db: Session, user: User, device_id: str, device_type: str = "cloud"
) -> Kind:
    existing = (
        db.query(Kind)
        .filter(
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == device_id,
            Kind.user_id == user.id,
            Kind.is_active == True,
        )
        .first()
    )
    if existing is not None:
        return existing
    device = Kind(
        kind="Device",
        name=device_id,
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={"spec": {"deviceType": device_type}},
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _make_execution(
    db: Session,
    item: LoopItem,
    bot: ProjectChatAgent,
    user: User,
    *,
    priority: str = "medium",
    automation_context: dict | None = None,
) -> LoopItemExecution:
    _ensure_device(db, user, "cloud-device-1")
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        agent=bot,
        assigner_user_id=user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority=priority,
        automation_context=automation_context,
    )
    db.commit()
    db.refresh(execution)
    return execution


def _make_running_automation_execution(
    db: Session,
    user: User,
) -> tuple[LoopItemExecution, ProjectAutomationRun, ProjectChatMessage]:
    """Create one fully linked running execution for terminal race tests."""

    project = _make_project(db, user)
    bot = _make_bot(db, project, user)
    item = _make_item(db, project, user)
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=item.id,
        title="Automation run",
        description="",
        status="running",
        created_by_user_id=user.id,
        metadata_json={},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=bot.id,
        sender_name=bot.title,
        message_type="agent_chunk",
        content="",
        metadata_json={"run_status": "running"},
        agent_id=bot.id,
        status="streaming",
    )
    db.add_all([run, activity])
    db.commit()
    execution = _make_execution(
        db,
        item,
        bot,
        user,
        automation_context={
            "run_id": str(run.id),
            "activity_message_id": message_id,
        },
    )
    claimed = loop_item_execution_service.claim(
        db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    activity.runtime_device_id = claimed.runtime_device_id
    activity.runtime_task_id = claimed.runtime_task_id
    db.commit()
    running = loop_item_execution_service.handle_runtime_event(
        db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
    )
    assert running is not None and running.status == "running"
    db.refresh(activity)
    return running, run, activity


def test_stop_execution_rejects_an_execution_from_another_project(
    test_db: Session, test_user: User
) -> None:
    """A project-scoped stop URL must not be usable as an authorization shell."""

    from fastapi import BackgroundTasks

    from app.api.endpoints.loop_item_executions import stop_execution

    allowed_project = _make_project(test_db, test_user)
    target_project = _make_project(test_db, test_user)
    target_bot = _make_bot(test_db, target_project, test_user)
    target = _make_execution(
        test_db,
        _make_item(test_db, target_project, test_user),
        target_bot,
        test_user,
    )

    with pytest.raises(HTTPException) as error:
        stop_execution(
            project_id=int(allowed_project.id),
            execution_id=target.id,
            background_tasks=BackgroundTasks(),
            db=test_db,
            current_user=test_user,
        )

    assert error.value.status_code == 404
    test_db.refresh(target)
    assert target.status == "queued"


def test_claim_is_atomic_and_serial_per_robot(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    first = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    second = _make_execution(
        test_db, _make_item(test_db, project, test_user, title="Second"), bot, test_user
    )

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    assert claimed.id == first.id
    assert claimed.status == "claimed"
    assert claimed.lease_expires_at is not None

    # A robot only runs one task at a time, so the second stays queued.
    blocked = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert blocked is None
    test_db.refresh(second)
    assert second.status == "queued"


def test_device_capacity_is_shared_across_robots(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot_a = _make_bot(test_db, project, test_user, mode="auto")
    bot_b = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Bot B",
        name="Bot B",
        status="active",
        created_by_user_id=test_user.id,
        device_id="cloud-device-1",
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "execution_environment": "cloud",
            "visibility": "public",
        },
    )
    test_db.add(bot_b)
    test_db.commit()
    test_db.refresh(bot_b)
    item_a = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot_a, test_user
    )
    item_b = _make_execution(
        test_db, _make_item(test_db, project, test_user, title="B"), bot_b, test_user
    )

    first = loop_item_execution_service.claim(
        test_db,
        agent_id=bot_a.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert first is not None
    # Device capacity is 1: the second robot cannot start on the same device.
    blocked = loop_item_execution_service.claim(
        test_db,
        agent_id=bot_b.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=1,
    )
    assert blocked is None
    test_db.refresh(item_b)
    assert item_b.status == "queued"
    # Releasing the slot lets the next robot run.
    loop_item_execution_service.complete(test_db, execution_id=first.id)
    second = loop_item_execution_service.claim(
        test_db,
        agent_id=bot_b.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=1,
    )
    assert second is not None
    assert second.id == item_b.id


def test_claim_next_for_device_orders_by_priority(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Low", priority="low"),
        bot,
        test_user,
        priority="low",
    )
    urgent = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Urgent", priority="urgent"),
        bot,
        test_user,
        priority="urgent",
    )

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    assert claimed.id == urgent.id


def test_heartbeat_and_complete_release_slot(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    refreshed = loop_item_execution_service.heartbeat(
        test_db,
        execution_id=claimed.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
    )
    assert refreshed is not None
    assert refreshed.runtime_task_id == claimed.runtime_task_id
    assert refreshed.heartbeat_at is not None

    done = loop_item_execution_service.complete(test_db, execution_id=claimed.id)
    assert done is not None
    assert done.status == "completed"
    assert loop_datetime_value_is_unset(done.lease_expires_at)
    # The slot is free again.
    next_claim = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert next_claim is None  # only one queued run existed


def test_runtime_events_renew_the_lease(test_db: Session, test_user: User) -> None:
    """Streaming runtime events must renew the run lease.

    Regression: handle_runtime_event only touched heartbeat_at, so any run
    that streamed past the lease period was force-failed by lease recovery
    even while the executor was actively working, and a dead executor's run
    kept the agent slot blocked for up to two lease periods.
    """

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=claimed.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
    )
    original_lease = claimed.lease_expires_at

    refreshed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.output_text.delta",
        payload={"eventSeq": 1, "data": {"delta": "tick"}},
    )
    assert refreshed is not None
    assert refreshed.lease_expires_at > original_lease


def test_runtime_completion_finishes_project_automation(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=item.id,
        title="Automation run",
        description="",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.commit()
    execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context={"run_id": str(run.id)},
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=execution.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
    )

    completed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.completed",
        payload={"eventSeq": 1, "data": {}},
    )

    assert completed is not None
    assert completed.status == "completed"
    test_db.refresh(run)
    assert run.status == "succeeded"
    assert run.completed_at is not None
    # A successful run without spawned child tasks must not inherit the
    # bug-scan wording ("No bugs found.").
    assert run.description == "Run succeeded."


def test_complete_wins_concurrent_cancel_across_independent_sessions(
    independent_session_database,
) -> None:
    factory, user = independent_session_database
    setup_session = factory()
    execution, run, activity = _make_running_automation_execution(setup_session, user)
    execution_id = execution.id
    run_id = run.id
    activity_id = activity.id
    setup_session.close()

    complete_session = factory()
    cancel_session = factory()
    states_observed_by_push: list[tuple[str, str, str]] = []

    def observe_committed_projection(_payload: dict) -> None:
        observer = factory()
        try:
            states_observed_by_push.append(
                (
                    observer.get(LoopItemExecution, execution_id).status,
                    observer.get(ProjectAutomationRun, run_id).status,
                    observer.get(ProjectChatMessage, activity_id).status,
                )
            )
        finally:
            observer.close()

    try:
        # Both request sessions observe the same active version before either
        # terminal writer commits.
        assert complete_session.get(LoopItemExecution, execution_id).status == "running"
        assert cancel_session.get(LoopItemExecution, execution_id).status == "running"
        with patch(
            "app.services.project_chat.push.push_project_chat_message",
            side_effect=observe_committed_projection,
        ) as push_message:
            completed = loop_item_execution_service.complete(
                complete_session,
                execution_id=execution_id,
                content="Completed by the runtime",
            )
            complete_session.rollback()
            cancelled = loop_item_execution_service.cancel(
                cancel_session,
                execution_id=execution_id,
                note="Concurrent user cancellation",
            )
        assert completed is not None and completed.status == "completed"
        assert cancelled.status == "completed"
        push_message.assert_called_once()
        assert states_observed_by_push == [("completed", "succeeded", "completed")]
    finally:
        complete_session.close()
        cancel_session.close()

    verify_session = factory()
    try:
        persisted_execution = verify_session.get(LoopItemExecution, execution_id)
        persisted_run = verify_session.get(ProjectAutomationRun, run_id)
        persisted_activity = verify_session.get(ProjectChatMessage, activity_id)
        assert persisted_execution.status == "completed"
        assert persisted_run.status == "succeeded"
        assert persisted_activity.status == "completed"
        assert persisted_activity.content == "Completed by the runtime"
        assert persisted_activity.metadata_json["run_status"] == "completed"
    finally:
        verify_session.close()


def test_cancel_wins_concurrent_fail_across_independent_sessions(
    independent_session_database,
) -> None:
    factory, user = independent_session_database
    setup_session = factory()
    execution, run, activity = _make_running_automation_execution(setup_session, user)
    execution_id = execution.id
    run_id = run.id
    activity_id = activity.id
    setup_session.close()

    fail_session = factory()
    cancel_session = factory()
    try:
        assert fail_session.get(LoopItemExecution, execution_id).status == "running"
        assert cancel_session.get(LoopItemExecution, execution_id).status == "running"
        with patch(
            "app.services.project_chat.push.push_project_chat_message"
        ) as push_message:
            cancelled = loop_item_execution_service.cancel(
                cancel_session,
                execution_id=execution_id,
                note="Stopped by a project developer",
            )
            assert cancelled.status == "cancel_requested"
            cancelled = loop_item_execution_service.confirm_runtime_cancelled(
                cancel_session,
                execution_id=execution_id,
                note="Stopped by a project developer",
            )
            cancel_session.rollback()
            failed = loop_item_execution_service.fail(
                fail_session,
                execution_id=execution_id,
                error="Late runtime failure",
            )
        assert cancelled is not None and cancelled.status == "cancelled"
        assert failed is not None and failed.status == "cancelled"
        assert push_message.call_count == 2
    finally:
        fail_session.close()
        cancel_session.close()

    verify_session = factory()
    try:
        persisted_execution = verify_session.get(LoopItemExecution, execution_id)
        persisted_run = verify_session.get(ProjectAutomationRun, run_id)
        persisted_activity = verify_session.get(ProjectChatMessage, activity_id)
        assert persisted_execution.status == "cancelled"
        assert persisted_run.status == "cancelled"
        assert persisted_activity.status == "cancelled"
        assert persisted_activity.content == "Stopped by a project developer"
        assert persisted_activity.metadata_json["run_status"] == "cancelled"
    finally:
        verify_session.close()


def test_runtime_cancelled_is_terminal_and_never_requeued(
    test_db: Session,
    test_user: User,
) -> None:
    execution, run, activity = _make_running_automation_execution(test_db, test_user)

    with patch(
        "app.services.project_chat.push.push_project_chat_message"
    ) as push_message:
        cancelled = loop_item_execution_service.handle_runtime_event(
            test_db,
            device_id=execution.runtime_device_id,
            runtime_task_id=execution.runtime_task_id,
            event_name="response.incomplete",
            payload={"eventSeq": 2, "data": {"status": "CANCELLED"}},
        )

    assert cancelled is not None
    assert cancelled.status == "cancelled"
    assert cancelled.retry_attempt == 0
    test_db.refresh(run)
    test_db.refresh(activity)
    assert run.status == "cancelled"
    assert activity.status == "cancelled"
    assert activity.metadata_json["run_status"] == "cancelled"
    push_message.assert_called_once()


def test_failed_runtime_event_after_cancel_request_is_never_requeued(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    original = _make_execution(
        test_db,
        _make_item(test_db, project, test_user),
        bot,
        test_user,
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    running = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
    )
    assert running is not None and running.status == "running"

    requested = loop_item_execution_service.cancel(
        test_db,
        execution_id=original.id,
        note="Workflow was paused",
    )
    assert requested.status == "cancel_requested"

    cancelled = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.failed",
        payload={"eventSeq": 2, "error": "cancelled", "data": {}},
    )

    assert cancelled is not None
    assert cancelled.id == original.id
    assert cancelled.status == "cancelled"
    assert cancelled.retry_attempt == 0
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == original.loop_item_id)
        .all()
    )
    assert [execution.id for execution in executions] == [original.id]


def test_delivered_cancel_waits_for_runtime_stop_confirmation(
    test_db: Session, test_user: User
) -> None:
    execution, _, _ = _make_running_automation_execution(test_db, test_user)

    requested = loop_item_execution_service.cancel(
        test_db,
        execution_id=execution.id,
        note="User requested stop",
    )
    assert requested.status == "cancel_requested"
    assert loop_datetime_value_is_unset(requested.completed_at)

    confirmed = loop_item_execution_service.confirm_runtime_cancelled(
        test_db,
        execution_id=execution.id,
        note="Runtime confirmed stop",
    )
    assert confirmed is not None
    assert confirmed.status == "cancelled"
    assert confirmed.observed_state == "cancelled"
    assert confirmed.termination_reason == "runtime_cancel_acknowledged"


def test_runtime_retry_uses_a_new_execution_attempt(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    original = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    running = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
    )
    assert running is not None and running.status == "running"

    retry = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.failed",
        payload={"eventSeq": 2, "error": "model crashed", "data": {}},
    )

    assert retry is not None
    assert retry.id != original.id
    assert retry.status == "queued"
    assert retry.attempt_no == 2
    assert retry.previous_execution_id == original.id
    assert retry.runtime_task_id != claimed.runtime_task_id
    test_db.refresh(original)
    assert original.status == "failed"
    assert original.last_event_seq == 2


def test_reordered_runtime_event_cannot_overwrite_newer_truth(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _make_execution(test_db, _make_item(test_db, project, test_user), bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    newest = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.output_text.delta",
        payload={"eventSeq": 2, "data": {"delta": "new"}},
    )
    assert newest is not None and newest.status == "running"

    stale = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.completed",
        payload={"eventSeq": 1, "data": {}},
    )
    assert stale is None
    test_db.refresh(claimed)
    assert claimed.status == "running"
    assert claimed.last_event_seq == 2


def test_later_runtime_event_cannot_overwrite_terminal_truth(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    _make_execution(test_db, _make_item(test_db, project, test_user), bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    completed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.completed",
        payload={"eventSeq": 1, "data": {"value": "durable winner"}},
    )
    assert completed is not None and completed.status == "completed"

    conflicting = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.failed",
        payload={"eventSeq": 2, "error": "late failure", "data": {}},
    )

    assert conflicting is None
    test_db.refresh(claimed)
    assert claimed.status == "completed"
    assert claimed.observed_state == "succeeded"
    assert claimed.last_event_seq == 1


def test_automation_execution_finishes_its_exact_run_without_child_aggregation(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=item.id,
        title="Automation run",
        description="",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    child = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        parent_id=item.id,
        title="Child work",
        description="",
        status="inbox",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.add(child)
    test_db.commit()
    child_execution = _make_execution(
        test_db,
        child,
        bot,
        test_user,
        automation_context={"run_id": str(run.id)},
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=child_execution.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
    )

    completed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.completed",
        payload={"eventSeq": 1, "data": {}},
    )

    assert completed is not None
    assert completed.status == "completed"
    test_db.refresh(run)
    assert run.status == "succeeded"
    assert run.description == "Run succeeded."


def test_complete_truncates_long_execution_note(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)

    completed = loop_item_execution_service.complete(
        test_db,
        execution_id=execution.id,
        note="验" * 600,
    )

    assert completed is not None
    assert completed.status == "completed"
    assert completed.execution_note == "验" * 500


def test_unstarted_claim_lease_expiry_releases_without_consuming_retry(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed_rows = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        lease_seconds=60,
    )
    assert len(claimed_rows) == 1
    claimed = claimed_rows[0]
    assert claimed.status == "claimed"
    expired = claimed.lease_expires_at - timedelta(seconds=120)
    claimed.lease_expires_at = expired
    test_db.commit()

    requeued, unknown = loop_item_execution_service.recovery_scan(
        test_db,
        now=claimed.lease_expires_at + timedelta(seconds=120),
        lease_seconds=60,
    )
    assert (requeued, unknown) == (1, 0)
    test_db.refresh(claimed)
    assert claimed.status == "queued"
    assert claimed.retry_attempt == 0

    # A second abandoned claim is equally safe to release because Start was
    # never delivered; infrastructure availability does not consume run retry.
    re_claimed_rows = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        lease_seconds=60,
    )
    assert len(re_claimed_rows) == 1
    re_claimed = re_claimed_rows[0]
    re_claimed.lease_expires_at = re_claimed.lease_expires_at - timedelta(seconds=120)
    test_db.commit()
    requeued, unknown = loop_item_execution_service.recovery_scan(
        test_db,
        now=re_claimed.lease_expires_at + timedelta(seconds=120),
        lease_seconds=60,
    )
    assert (requeued, unknown) == (1, 0)
    test_db.refresh(re_claimed)
    assert re_claimed.status == "queued"
    assert re_claimed.retry_attempt == 0


def test_recovery_scan_repairs_terminal_automation_projection(
    test_db: Session, test_user: User
) -> None:
    """A terminal execution must repair its run and activity after a crash."""

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose an assignee.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
            "model": "test-model",
            "execution_environment": "cloud",
            "execution_device_id": "cloud-device-1",
        },
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        description="",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "event"},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id="automation_manager:pending",
        sender_name="Custom AI manager",
        message_type="agent_status",
        content="",
        metadata_json={"run_status": "queued"},
        status="pending",
    )
    test_db.add_all([rule, run, activity])
    test_db.flush()
    execution = loop_item_execution_service.enqueue_automation_manager(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="medium",
        automation_context={"run_id": str(run.id)},
    )
    assert execution.team_id == 0
    assert execution.backend_task_id == 0
    assert execution.executor_type == "automation_manager"
    run.metadata_json = {
        "trigger": "event",
        "activity_message_id": message_id,
    }
    activity.metadata_json = {
        "execution_id": execution.id,
        "run_status": "queued",
    }
    execution.status = "failed"
    execution.retry_attempt = execution.max_retries
    execution.error_message = "manager dispatch failed"
    execution.completed_at = datetime(2026, 8, 14, 8, 22, 40)
    test_db.commit()

    requeued, failed = loop_item_execution_service.recovery_scan(test_db)

    assert (requeued, failed) == (0, 0)
    test_db.refresh(run)
    test_db.refresh(activity)
    assert run.status == "failed"
    assert run.description == "manager dispatch failed"
    assert run.completed_at == execution.completed_at
    assert activity.status == "failed"
    assert activity.message_type == "text"
    assert activity.content == "manager dispatch failed"
    assert activity.metadata_json["run_status"] == "failed"
    repaired_version = run.version

    loop_item_execution_service.recovery_scan(test_db)

    test_db.refresh(run)
    assert run.version == repaired_version


@pytest.mark.asyncio
async def test_retry_run_redispatches_the_same_processor_record_and_task(
    test_db: Session, test_user: User
) -> None:
    from app.services.project_automations import project_automation_service

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose an assignee.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
            "model": "test-model",
            "execution_environment": "cloud",
            "execution_device_id": "cloud-device-1",
            "timezone": "Asia/Shanghai",
        },
    )
    failed_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Failed run",
        description="manager failed",
        source="event",
        status="failed",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger": "event",
            "event": {
                "type": "task.created",
                "subject_id": item.id,
                "payload": {"title": item.title},
            },
        },
    )
    test_db.add_all([rule, failed_run])
    test_db.commit()

    with patch.object(
        project_automation_execution,
        "dispatch",
        new_callable=AsyncMock,
    ) as dispatch:
        view = await project_automation_service.retry_run(
            test_db,
            str(project.id),
            str(failed_run.id),
            test_user.id,
        )

    retried = test_db.get(ProjectAutomationRun, view["id"])
    assert retried is not None
    assert retried.id == failed_run.id
    assert retried.task_id == item.id
    assert retried.status == "pending"
    assert retried.source == "event"
    assert retried.metadata_json["retry_count"] == 1
    assert retried.metadata_json["retry_execution_floor_id"] == 0
    assert retried.metadata_json["event"]["subject_id"] == item.id
    assert retried.description == ""
    test_db.refresh(failed_run)
    assert failed_run.status == "pending"
    dispatch.assert_awaited_once_with(test_db, rule, retried)


@pytest.mark.asyncio
async def test_retry_run_rejects_a_second_retry_while_same_record_is_active(
    test_db: Session, test_user: User
) -> None:
    from app.services.project_automations import project_automation_service

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose an assignee.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"timezone": "Asia/Shanghai"},
    )
    failed_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Failed run",
        description="manager failed",
        source="event",
        status="failed",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "event"},
    )
    test_db.add_all([rule, failed_run])
    test_db.commit()

    with patch.object(
        project_automation_execution,
        "dispatch",
        new_callable=AsyncMock,
    ) as dispatch:
        await project_automation_service.retry_run(
            test_db,
            str(project.id),
            str(failed_run.id),
            test_user.id,
        )
        with pytest.raises(HTTPException) as exc_info:
            await project_automation_service.retry_run(
                test_db,
                str(project.id),
                str(failed_run.id),
                test_user.id,
            )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Only a failed automation run can be retried"
    dispatch.assert_awaited_once()


@pytest.mark.asyncio
async def test_retry_processor_uses_only_executions_from_the_current_attempt(
    test_db: Session, test_user: User
) -> None:
    from app.services.project_automations import project_automation_processor

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    bot = _make_bot(test_db, project, test_user)
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose an assignee.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    failed_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Failed run",
        description="robot failed",
        source="event",
        status="failed",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "event"},
    )
    test_db.add_all([rule, failed_run])
    test_db.commit()
    previous_execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context={"run_id": str(failed_run.id)},
    )
    previous_execution.status = "failed"
    test_db.commit()

    with patch.object(
        project_automation_execution,
        "dispatch",
        new_callable=AsyncMock,
    ):
        await project_automation_processor.retry(
            test_db,
            run_id=str(failed_run.id),
            requested_by_user_id=test_user.id,
        )

    assert failed_run.metadata_json["retry_execution_floor_id"] == previous_execution.id
    assert (
        project_automation_execution._project_robot_execution_for_run(
            test_db, str(failed_run.id)
        )
        is None
    )

    current_execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context={"run_id": str(failed_run.id)},
    )

    assert (
        project_automation_execution._project_robot_execution_for_run(
            test_db, str(failed_run.id)
        )
        == current_execution
    )


def test_stall_scan_requests_cancel_without_faking_terminal_state(
    test_db: Session, test_user: User
) -> None:
    """A run that streams events but never produces assistant text for a long
    time must be stopped so the task unlocks and the device slot frees.

    Regression: lease renewal kept event-flowing runs alive forever, so a
    runaway tool loop with no text output stayed "执行中" indefinitely and the
    task could not be modified.
    """

    from datetime import timedelta

    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    running = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
    )
    assert running is not None
    running.started_at = running.started_at - timedelta(minutes=30)
    test_db.commit()
    stalled = loop_item_execution_service.stall_scan(
        test_db, text_timeout_seconds=20 * 60
    )
    assert [run.id for run in stalled] == [claimed.id]
    test_db.refresh(claimed)
    assert claimed.status == "cancel_requested"
    assert "未产生任何输出" in claimed.execution_note


def test_stall_scan_keeps_runs_with_text_output(
    test_db: Session, test_user: User
) -> None:
    """A long-running run that already produced assistant text is progress,
    not a stall, and must be left alone."""

    from datetime import timedelta

    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    running = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
    )
    assert running is not None
    running.started_at = running.started_at - timedelta(minutes=30)
    test_db.commit()
    activity = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == "cloud-device-1",
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .one()
    )
    activity.content = "real progress text"
    test_db.commit()

    stalled = loop_item_execution_service.stall_scan(
        test_db, text_timeout_seconds=20 * 60
    )
    assert stalled == []
    test_db.refresh(claimed)
    assert claimed.status == "running"


def test_approve_reject_only_creator(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    other = User(
        user_name="other-exec",
        password_hash="unused",
        email="other-exec@example.com",
        is_active=True,
    )
    test_db.add(other)
    test_db.commit()
    test_db.refresh(other)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    assert execution.status == "pending_approval"

    with pytest.raises(HTTPException, match="Only the executor owner"):
        loop_item_execution_service.approve(
            test_db, execution_id=execution.id, user_id=other.id
        )

    approved = loop_item_execution_service.approve(
        test_db, execution_id=execution.id, user_id=test_user.id
    )
    assert approved.status == "queued"
    assert approved.approval_status == "approved"


def test_claimed_run_builds_runtime_payload_for_executor(
    test_db: Session, test_user: User
) -> None:
    """A claimed run materializes current runtime config and task context."""

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "system_prompt": "Verify before reporting completion.",
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user, title="Build the landing page")
    item.description = "Create three subtasks for testing."
    test_db.commit()
    execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        priority="high",
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    assert claimed.execution_payload == ""

    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed
    )
    assert payload is not None
    execution_request = payload.get("executionRequest")
    assert isinstance(execution_request, dict)
    assert execution_request["task_id"]
    assert execution_request["bot"][0]["id"] == bot.id
    assert "system_prompt" not in execution_request["bot"][0]
    assert "system_prompt" not in execution_request
    assert "Build the landing page" not in execution_request["prompt"]
    assert "Create three subtasks for testing." not in execution_request["prompt"]
    assert execution_request["prompt"] == (
        f"project_id: {project.id}\n"
        f"task_id: {item.id}\n"
        f"execution_id: {claimed.id}\n\n"
        f"看板任务数据位于 cloud://projects/{project.id}/todos/{item.id}，"
        "请通过看板工具自行查看。\n\n"
        "Verify before reporting completion."
    )
    assert execution_request["prompt"] == payload["message"]
    assert payload["additionalContext"] == {}
    assert execution_request["mcp_servers"] == []
    assert execution_request["preload_skills"] == []
    assert execution_request["user_selected_skills"] == []
    assert execution_request["new_session"] is True
    assert execution_request["ephemeral"] is False
    assert execution_request["is_group_chat"] is False
    assert execution_request["collaboration_model"] == "single"
    assert execution_request["mode"] == "code"
    assert execution_request["task_mode"] == "code"
    assert execution_request["attachments"] == []
    assert execution_request["runtime_permission_profile"] == ":danger-full-access"
    assert payload["cloudProjectId"] == str(project.id)
    assert "ephemeral" not in payload
    assert "continuable" not in payload
    assert payload["runtime"] == "codex"


def test_manager_runtime_payload_requires_mcp_reads_and_uses_bound_local_project(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    profile = WeworkExecutionProfile.for_automation_manager(
        owner_user_id=test_user.id,
        display_name="Managed AI",
        instruction="Run task",
        model="test-model",
        local_project_id=91,
    )
    payload = profile.build_runtime_payload(
        test_db,
        execution_id=91,
        runtime_task_id="runtime-task-1",
        task=TaskContext(
            id="item-1",
            cloud_project_id=str(project.id),
            title="Bound task",
            description="",
            status="inbox",
            priority="medium",
        ),
        cloud_project_id=str(project.id),
        origin_context={
            "run_id": "run-1",
            "rule_id": "rule-1",
            "event": {"type": "task.created"},
        },
    )

    assert payload["local_project_id"] == 91
    assert payload["executionRequest"]["standalone_chat_workspace"] is False
    assert payload["origin"]["automationRole"] == "manager"
    assert payload["origin"]["type"] == "project_automation"
    assert payload["message"] == "Run task"
    assert "system_prompt" not in payload["executionRequest"]
    assert "system_prompt" not in payload["executionRequest"]["bot"][0]
    assert payload["additionalContext"] == {}


def test_claim_binds_canonical_runtime_identity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    assert claimed.runtime_task_id == f"codex-queue-{claimed.id}"
    assert claimed.runtime_device_id == "cloud-device-1"

    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed
    )
    assert payload is not None
    assert payload["taskId"] == f"codex-queue-{claimed.id}"
    assert payload["executionRequest"]["task_id"] == f"codex-queue-{claimed.id}"
    assert payload["executionRequest"]["subtask_id"] == (
        f"codex-queue-{claimed.id}-assistant"
    )


def test_open_execution_activity_is_idempotent_and_opens_exactly_one_message(
    test_db: Session, test_user: User
) -> None:
    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None

    first = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    assert first is not None
    original_sender = (first.sender["id"], first.sender["name"], first.agent_id)
    bot.title = "Renamed after activity creation"
    test_db.commit()
    second = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    assert second is not None
    assert first.message_id == second.message_id
    assert (
        second.sender["id"],
        second.sender["name"],
        second.agent_id,
    ) == original_sender
    messages = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.task_id == item.id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    assert len(messages) == 1
    assert messages[0].status == "pending"
    assert messages[0].metadata_json["run_status"] == "starting"
    assert messages[0].runtime_task_id == f"codex-queue-{claimed.id}"


def test_open_execution_activity_never_revives_a_terminal_execution(
    independent_session_database,
) -> None:
    factory, user = independent_session_database
    setup_session = factory()
    execution, _, activity = _make_running_automation_execution(setup_session, user)
    execution_id = execution.id
    activity_id = activity.id
    setup_session.close()

    stale_session = factory()
    terminal_session = factory()
    try:
        stale_execution = stale_session.get(LoopItemExecution, execution_id)
        assert stale_execution is not None and stale_execution.status == "running"
        completed = loop_item_execution_service.complete(
            terminal_session,
            execution_id=execution_id,
            content="Completed before the transport start callback",
        )
        assert completed is not None and completed.status == "completed"

        opened = loop_item_execution_service.open_execution_activity(
            stale_session,
            execution=stale_execution,
        )

        assert opened is None
    finally:
        stale_session.close()
        terminal_session.close()

    verify_session = factory()
    try:
        persisted_activity = verify_session.get(ProjectChatMessage, activity_id)
        assert persisted_activity is not None
        assert persisted_activity.status == "completed"
        assert (
            persisted_activity.content
            == "Completed before the transport start callback"
        )
        assert persisted_activity.metadata_json["run_status"] == "completed"
    finally:
        verify_session.close()


def test_runtime_event_opens_activity_when_start_report_races_ahead(
    test_db: Session, test_user: User
) -> None:
    """Events arriving before the transport's start report must not be dropped."""

    from app.services.project_chat.service import project_chat_service

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None

    result = project_chat_service.project_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.output_text.delta",
        payload={"eventSeq": 1, "data": {"delta": "hello from the executor"}},
    )
    assert result is not None
    message, mode = result
    assert mode == "delta"
    assert message.content == "hello from the executor"


def test_runtime_running_event_projects_child_task_and_activity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None

    running = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
    )

    assert running is not None
    assert running.status == "running"
    test_db.refresh(item)
    assert item.status == "in_progress"
    activity = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == claimed.runtime_device_id,
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .one()
    )
    assert activity.status == "streaming"
    assert activity.metadata_json["run_status"] == "running"

    item.status = "pending"
    test_db.commit()
    heartbeat = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.in_progress",
        payload={"eventSeq": 2, "data": {}},
    )

    assert heartbeat is not None
    test_db.refresh(item)
    assert item.status == "in_progress"


def test_requeue_drops_empty_placeholder_activity(
    test_db: Session, test_user: User
) -> None:
    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    loop_item_execution_service.open_execution_activity(test_db, execution=claimed)

    loop_item_execution_service.fail(
        test_db,
        execution_id=claimed.id,
        error="device went offline",
        requeue_infra=True,
    )
    messages = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == "cloud-device-1",
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    assert messages == []


def test_placeholder_cleanup_allows_reopening_same_runtime(
    test_db: Session, test_user: User
) -> None:
    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None

    first = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    loop_item_execution_service.close_placeholder_activity(test_db, execution=claimed)
    second = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    assert first is not None and second is not None
    assert first.message_id == second.message_id

    active = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == "cloud-device-1",
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .all()
    )
    assert [message.message_id for message in active] == [second.message_id]


def test_terminal_report_closes_streaming_activity(
    test_db: Session, test_user: User
) -> None:
    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    loop_item_execution_service.open_execution_activity(test_db, execution=claimed)

    loop_item_execution_service.complete(
        test_db,
        execution_id=claimed.id,
        note="verified and fixed",
    )
    message = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == "cloud-device-1",
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .one()
    )
    assert message.status == "completed"
    assert message.content == "verified and fixed"


def test_terminal_failure_closes_streaming_activity_with_error(
    test_db: Session, test_user: User
) -> None:
    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    loop_item_execution_service.open_execution_activity(test_db, execution=claimed)

    loop_item_execution_service.fail(
        test_db,
        execution_id=claimed.id,
        error="stream disconnected before completion",
        requeue=False,
    )
    message = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == "cloud-device-1",
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .one()
    )
    assert message.status == "failed"
    assert message.content == "stream disconnected before completion"


def test_automation_robot_uses_the_same_visible_input_and_board_origin(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user, title="Scheduled bug scan")
    item.description = "Scan the checkout for reproducible bugs."
    item.metadata_json = {"automation": {"run_id": "run-123"}}
    test_db.commit()
    execution = _make_execution(test_db, item, bot, test_user)

    task = loop_item_execution_service.resolve_task_context(
        test_db, execution=execution, user_id=test_user.id
    )
    assert task is not None
    assert task.description == "Scan the checkout for reproducible bugs."

    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=execution
    )
    assert payload is not None
    assert payload["origin"]["type"] == "board_task"
    assert payload["origin"]["run_id"] == "run-123"
    assert payload["additionalContext"] == {}
    assert f"project_id: {project.id}" in payload["message"]
    assert f"task_id: {item.id}" in payload["message"]
    assert "Scheduled bug scan" not in payload["message"]
    assert "Scan the checkout for reproducible bugs." not in payload["message"]


def test_workflow_stage_instruction_contains_prompt_and_delivery_contract() -> None:
    instruction = workflow_stage_task_instruction(
        {
            "target_stage": {
                "prompt": "部署并测试，之后交付",
                "required_deliverables": [
                    {
                        "id": "deliverable-1",
                        "name": "测试报告",
                        "value_type": "file",
                        "description": "",
                    },
                    {
                        "id": "deliverable-2",
                        "name": "访问地址",
                        "value_type": "text",
                        "description": "必须可访问",
                    },
                ],
            }
        }
    )

    assert instruction.startswith("部署并测试，之后交付")
    assert "- [deliverable-1] 测试报告 (file)" in instruction
    assert "- [deliverable-2] 访问地址 (text)：必须可访问" in instruction
    assert "finalize_delivery" in instruction
    assert "requirement_id" in instruction


def test_inherited_stage_keeps_issue_identity_and_reuses_predecessor_workspace(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user, title="Deploy")
    profile = WeworkExecutionProfile.for_project_robot(bot)

    payload = profile.build_runtime_payload(
        test_db,
        execution_id=253,
        runtime_task_id="codex-queue-253",
        task=TaskContext(
            id=item.id,
            cloud_project_id=str(project.id),
            title=item.title,
            description="",
            status="in_progress",
            priority="medium",
        ),
        cloud_project_id=str(project.id),
        origin_context={
            "workflow_stage_input": {
                "target_stage": {
                    "id": "deploy",
                    "prompt": "部署并测试",
                    "workspace_policy": "inherit",
                    "required_deliverables": [],
                },
                "dependencies": [
                    {
                        "stage_id": "develop",
                        "runtime_tasks": [
                            {
                                "device_id": "cloud-device-1",
                                "task_id": "previous-runtime-task",
                            }
                        ],
                    }
                ],
            }
        },
        execution_device_id="cloud-device-1",
        materialize_execution_request=False,
    )

    assert f"task_id: {item.id}" in payload["message"]
    assert "task_id: previous-runtime-task" not in payload["message"]
    assert payload["workspaceSourceTask"] == {
        "deviceId": "cloud-device-1",
        "taskId": "previous-runtime-task",
    }
    assert payload["standaloneChatWorkspace"] is False


def test_claim_batch_moves_queued_to_claimed_within_capacity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot_b = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Bot B",
        name="Bot B",
        status="active",
        created_by_user_id=test_user.id,
        device_id="cloud-device-1",
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "execution_environment": "cloud",
            "visibility": "public",
        },
    )
    test_db.add(bot_b)
    test_db.commit()
    executions = [
        _make_execution(
            test_db,
            _make_item(test_db, project, test_user, title=f"Task {index}"),
            bot if index % 2 == 0 else bot_b,
            test_user,
        )
        for index in range(4)
    ]

    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=2,
        batch_size=4,
    )

    assert len(claimed) == 2
    assert [row.status for row in claimed] == ["claimed", "claimed"]
    assert all(row.lease_expires_at is not None for row in claimed)
    assert {row.agent_id for row in claimed} == {bot.id, bot_b.id}
    # Capacity 2 -> the remaining runs stay queued.
    test_db.refresh(executions[2])
    test_db.refresh(executions[3])
    assert executions[2].status == "queued"
    assert executions[3].status == "queued"


def test_claim_batch_respects_serial_per_robot(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    first = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    second = _make_execution(
        test_db, _make_item(test_db, project, test_user, title="Second"), bot, test_user
    )

    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=4,
        batch_size=4,
    )
    assert len(claimed) == 1
    assert claimed[0].id == first.id
    test_db.refresh(second)
    assert second.status == "queued"


def test_claim_batch_allows_configured_robot_parallelism(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {**bot.metadata_json, "max_concurrent_executions": 2}
    test_db.commit()
    executions = [
        _make_execution(
            test_db,
            _make_item(test_db, project, test_user, title=f"Parallel {index}"),
            bot,
            test_user,
        )
        for index in range(3)
    ]

    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=4,
        runtime_active=0,
        runtime_active_task_ids=set(),
        batch_size=4,
    )

    assert [row.id for row in claimed] == [executions[0].id, executions[1].id]
    test_db.refresh(executions[2])
    assert executions[2].status == "queued"


def test_runtime_capacity_is_shared_across_device_routes(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    first_bot = _make_bot(test_db, project, test_user)
    second_bot = _make_bot(test_db, project, test_user)
    second_bot.device_id = "app-route"
    test_db.commit()
    first = _make_execution(
        test_db, _make_item(test_db, project, test_user), first_bot, test_user
    )
    second = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Second route"),
        second_bot,
        test_user,
    )

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=first_bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="shared-runtime",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    blocked = loop_item_execution_service.claim(
        test_db,
        agent_id=second_bot.id,
        execution_device_id="app-route",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="shared-runtime",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )

    assert claimed is not None and claimed.id == first.id
    assert blocked is None
    test_db.refresh(second)
    assert second.status == "queued"


def test_runtime_active_tasks_reduce_claimable_capacity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=2,
        runtime_active=2,
        runtime_active_task_ids={"manual-1", "manual-2"},
    )

    assert claimed is None
    test_db.refresh(execution)
    assert execution.status == "queued"


def test_runtime_task_id_deduplicates_live_process_and_durable_claim(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    first_bot = _make_bot(test_db, project, test_user)
    second_bot = _make_bot(test_db, project, test_user)
    first = _make_execution(
        test_db, _make_item(test_db, project, test_user), first_bot, test_user
    )
    second = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Second task"),
        second_bot,
        test_user,
    )

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=first_bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=2,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None and claimed.id == first.id

    blocked_by_manual_process = loop_item_execution_service.claim(
        test_db,
        agent_id=second_bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=2,
        runtime_active=1,
        runtime_active_task_ids={"manual-task"},
    )
    assert blocked_by_manual_process is None

    claimed_after_runtime_observation = loop_item_execution_service.claim(
        test_db,
        agent_id=second_bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=2,
        runtime_active=1,
        runtime_active_task_ids={claimed.runtime_task_id},
    )
    assert claimed_after_runtime_observation is not None
    assert claimed_after_runtime_observation.id == second.id


def test_batch_round_robins_robots_within_the_same_priority(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    first_bot = _make_bot(test_db, project, test_user)
    first_bot.metadata_json = {
        **first_bot.metadata_json,
        "max_concurrent_executions": 20,
    }
    second_bot = _make_bot(test_db, project, test_user)
    test_db.commit()
    first_rows = [
        _make_execution(
            test_db,
            _make_item(test_db, project, test_user, title=f"First {index}"),
            first_bot,
            test_user,
        )
        for index in range(20)
    ]
    second = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Second robot"),
        second_bot,
        test_user,
    )

    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=2,
        runtime_active=0,
        runtime_active_task_ids=set(),
        batch_size=2,
    )

    assert [row.id for row in claimed] == [first_rows[0].id, second.id]


def test_single_claim_prefers_the_least_active_robot_within_priority(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    first_bot = _make_bot(test_db, project, test_user)
    first_bot.metadata_json = {
        **first_bot.metadata_json,
        "max_concurrent_executions": 20,
    }
    second_bot = _make_bot(test_db, project, test_user)
    test_db.commit()
    for index in range(3):
        _make_execution(
            test_db,
            _make_item(test_db, project, test_user, title=f"First {index}"),
            first_bot,
            test_user,
        )
    second = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Second robot"),
        second_bot,
        test_user,
    )

    first_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        runtime_instance_id="runtime-1",
        device_capacity=4,
        runtime_active=0,
        runtime_active_task_ids=set(),
        owner_user_id=test_user.id,
    )
    second_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        runtime_instance_id="runtime-1",
        device_capacity=4,
        runtime_active=0,
        runtime_active_task_ids=set(),
        owner_user_id=test_user.id,
    )

    assert first_claim is not None and first_claim.agent_id == first_bot.id
    assert second_claim is not None and second_claim.id == second.id


def test_ambiguous_active_capacity_identity_blocks_new_claims(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    first_bot = _make_bot(test_db, project, test_user)
    second_bot = _make_bot(test_db, project, test_user)
    first = _make_execution(
        test_db, _make_item(test_db, project, test_user), first_bot, test_user
    )
    second = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Blocked"),
        second_bot,
        test_user,
    )
    first.status = "claimed"
    first.runtime_instance_id = ""
    test_db.commit()

    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=second_bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=4,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )

    assert claimed is None
    test_db.refresh(second)
    assert second.status == "queued"


def test_mark_start_requested_preserves_claimed_state(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    first = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    second = _make_execution(
        test_db, _make_item(test_db, project, test_user, title="Second"), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        runtime_active=0,
        runtime_active_task_ids=set(),
        device_capacity=2,
        batch_size=2,
    )
    assert len(claimed) == 1
    # second is still queued; recording Start delivery must not touch it or
    # claim the Runtime has begun executing.
    advanced = loop_item_execution_service.mark_start_requested(
        test_db,
        execution_ids=[claimed[0].id, second.id],
    )
    assert advanced == 1
    test_db.refresh(claimed[0])
    test_db.refresh(second)
    assert claimed[0].status == "claimed"
    assert not loop_datetime_value_is_unset(claimed[0].start_requested_at)
    assert second.status == "queued"


def test_mark_start_requested_binds_automated_stage_runtime_task(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    item.metadata_json = {
        "workflow": {
            "version": 1,
            "nodes": [
                {
                    "id": "deploy",
                    "name": "部署",
                    "status": "queued",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "none",
                    "automation_rule_id": "rule-1",
                    "required_deliverables": [
                        {
                            "id": "deliverable-1",
                            "name": "测试报告",
                            "value_type": "file",
                        }
                    ],
                }
            ],
        }
    }
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=item.id,
        title="Deploy",
        description="",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow_stage_input": {
                "version": 1,
                "issue": {"id": item.id},
                "target_stage": {
                    "id": "deploy",
                    "name": "部署",
                    "prompt": "部署并测试",
                    "workspace_policy": "none",
                    "required_deliverables": [
                        {
                            "id": "deliverable-1",
                            "name": "测试报告",
                            "value_type": "file",
                        }
                    ],
                },
                "dependencies": [],
                "sha256": "stage-snapshot",
            }
        },
    )
    test_db.add(run)
    test_db.commit()
    execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context={"run_id": str(run.id)},
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None and claimed.id == execution.id

    assert (
        loop_item_execution_service.mark_start_requested(
            test_db, execution_ids=[claimed.id]
        )
        == 1
    )

    binding = (
        test_db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == item.id,
            LoopItemTaskBinding.task_id == claimed.runtime_task_id,
        )
        .one()
    )
    assert binding.device_id == "cloud-device-1"
    assert binding.workflow_node_id == "deploy"
    assert binding.metadata_json["workflow_stage_input_sha256"] == "stage-snapshot"


def test_runtime_start_fence_requires_exact_claim_identity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]

    assert (
        loop_item_execution_service.request_runtime_start(
            test_db,
            execution_id=claimed.id,
            runtime_device_id="foreign-device",
            runtime_task_id=claimed.runtime_task_id,
        )
        is None
    )
    assert (
        loop_item_execution_service.request_runtime_start(
            test_db,
            execution_id=claimed.id,
            runtime_device_id=claimed.runtime_device_id,
            runtime_task_id="codex-queue-foreign",
        )
        is None
    )
    test_db.refresh(execution)
    assert loop_datetime_value_is_unset(execution.start_requested_at)

    fenced = loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )
    assert fenced is not None
    assert fenced.status == "claimed"
    assert fenced.observed_state == "unconfirmed"
    assert not loop_datetime_value_is_unset(fenced.start_requested_at)


def test_unknown_runtime_dispatch_is_not_failed_or_requeued(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )

    unknown = loop_item_execution_service.report_runtime_dispatch_unknown(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        error="Runtime acceptance response was lost",
    )
    assert unknown is not None
    assert unknown.status == "claimed"
    assert unknown.sync_state == "stale"
    assert execution_display_state(unknown) == "unknown"
    assert unknown.completed_at is None or loop_datetime_value_is_unset(
        unknown.completed_at
    )

    # A delivered attempt cannot be converted into a preflight failure.
    unchanged = loop_item_execution_service.fail_runtime_preflight(
        test_db,
        execution_id=claimed.id,
        error="late local error",
    )
    assert unchanged is not None
    assert unchanged.status == "claimed"
    assert unchanged.sync_state == "stale"


def test_preflight_failure_is_terminal_only_before_start_delivery(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]

    failed = loop_item_execution_service.fail_runtime_preflight(
        test_db,
        execution_id=claimed.id,
        error="Runtime configuration is invalid",
    )
    assert failed is not None
    assert failed.status == "failed"
    assert failed.termination_reason == "runtime_failed"
    assert failed.observed_state == "failed"


def test_runtime_reconciliation_uses_terminal_turn_status(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )
    loop_item_execution_service.mark_dispatch_unknown(
        test_db,
        execution_id=claimed.id,
        error="Runtime event was lost",
    )

    with patch(
        "app.services.project_chat.push.push_project_chat_message"
    ) as push_message:
        reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
            test_db,
            execution_id=claimed.id,
            runtime_status="active",
            running=False,
            turn_status="completed",
        )

    assert reconciled is not None
    assert reconciled.status == "completed"
    assert reconciled.observed_state == "succeeded"
    assert reconciled.sync_state == "in_sync"
    assert execution_display_state(reconciled) == "succeeded"
    activity = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == claimed.runtime_device_id,
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .one()
    )
    assert activity.status == "completed"
    assert activity.metadata_json["run_status"] == "completed"
    push_message.assert_called_once()


def test_runtime_reconciliation_restores_missing_running_activity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )
    assert (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == claimed.runtime_device_id,
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .count()
        == 0
    )

    with patch(
        "app.services.project_chat.push.push_project_chat_message"
    ) as push_message:
        reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
            test_db,
            execution_id=claimed.id,
            runtime_status="running",
            running=True,
        )

    assert reconciled is not None
    assert reconciled.status == "running"
    activity = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.runtime_device_id == claimed.runtime_device_id,
            ProjectChatMessage.runtime_task_id == claimed.runtime_task_id,
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
        )
        .one()
    )
    assert activity.status == "streaming"
    assert activity.metadata_json["run_status"] == "running"
    push_message.assert_called_once()


def test_runtime_queued_snapshot_is_accepted_not_running(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )
    loop_item_execution_service.mark_dispatch_unknown(
        test_db,
        execution_id=claimed.id,
        error="Runtime acceptance response was lost",
    )

    reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
        test_db,
        execution_id=claimed.id,
        runtime_status="queued",
        running=False,
    )

    assert reconciled is not None
    assert reconciled.status == "claimed"
    assert reconciled.observed_state == "accepted"
    assert reconciled.sync_state == "in_sync"
    assert execution_display_state(reconciled) == "waiting_runtime"
    assert loop_datetime_value_is_unset(reconciled.started_at)


def test_missing_runtime_task_after_start_timeout_requeues_same_execution(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )
    loop_item_execution_service.mark_dispatch_unknown(
        test_db,
        execution_id=claimed.id,
        error="Runtime start confirmation timed out",
    )

    reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
        test_db,
        execution_id=claimed.id,
        runtime_status="missing",
        running=False,
    )

    assert reconciled is not None
    assert reconciled.id == execution.id
    assert reconciled.status == "queued"
    assert reconciled.observed_state == "unconfirmed"
    assert reconciled.sync_state == "pending"
    assert reconciled.termination_reason == ""
    assert loop_datetime_value_is_unset(reconciled.start_requested_at)
    assert loop_datetime_value_is_unset(reconciled.observed_at)
    reclaimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert reclaimed is not None
    assert reclaimed.id == execution.id


def test_missing_runtime_task_before_start_timeout_keeps_start_fence(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )[0]
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )

    reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
        test_db,
        execution_id=claimed.id,
        runtime_status="missing",
        running=False,
    )

    assert reconciled is not None
    assert reconciled.status == "claimed"
    assert reconciled.sync_state == "diverged"
    assert loop_datetime_value_is_unset(reconciled.start_requested_at) is False


def test_missing_cancel_requested_runtime_task_releases_capacity(
    test_db: Session, test_user: User
) -> None:
    running, _, _ = _make_running_automation_execution(test_db, test_user)
    project = test_db.get(CloudProject, running.cloud_project_id)
    bot = test_db.get(ProjectChatAgent, running.agent_id)
    assert project is not None
    assert bot is not None
    queued = _make_execution(
        test_db,
        _make_item(test_db, project, test_user, title="Next execution"),
        bot,
        test_user,
    )
    requested = loop_item_execution_service.cancel(
        test_db,
        execution_id=running.id,
        note="User requested stop",
    )
    assert requested.status == "cancel_requested"
    blocked = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert blocked is None

    reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
        test_db,
        execution_id=running.id,
        runtime_status="missing",
        running=False,
    )

    assert reconciled is not None
    assert reconciled.status == "cancelled"
    assert reconciled.observed_state == "cancelled"
    assert reconciled.sync_state == "in_sync"
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    assert claimed.id == queued.id


def test_claimed_lease_expiry_requeues_run(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_batch_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        lease_seconds=60,
    )
    assert len(claimed) == 1
    expired = claimed[0].lease_expires_at - timedelta(seconds=120)
    claimed[0].lease_expires_at = expired
    test_db.commit()

    requeued, failed = loop_item_execution_service.recovery_scan(
        test_db,
        now=expired + timedelta(seconds=120),
        lease_seconds=60,
    )
    assert (requeued, failed) == (1, 0)
    test_db.refresh(claimed[0])
    assert claimed[0].status == "queued"


def test_claim_materializes_current_model_config_without_persisting_credentials(
    test_db: Session, test_user: User
) -> None:
    """A queued row stores only intent; dispatch resolves current credentials."""

    from unittest.mock import patch

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "model": "wecode-moonshot-kimi-k2.7-code-highspeed(公网)",
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user)
    full_config = {
        "model": "openai",
        "model_id": "moonshot-kimi-k2.7-code-highspeed",
        "api_format": "responses",
        "protocol": "openai-responses",
        "base_url": "https://gateway.example.com",
        "api_key": "sk-wecode-test",
        "default_headers": {"wecode-source": "agent", "wecode-user": "tester"},
        "upstream_api_format": "anthropic-messages",
    }
    with patch(
        "app.services.chat.trigger.unified.build_wework_runtime_model_config",
        side_effect=AssertionError("model credentials must not resolve at enqueue"),
    ):
        execution = _make_execution(test_db, item, bot, test_user)
    assert execution.execution_payload == ""
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None
    with (
        patch.object(
            loop_item_execution_service,
            "_materialize_backend_request",
            return_value=True,
        ),
        patch(
            "app.services.chat.trigger.unified.build_wework_runtime_model_config",
            return_value=full_config,
        ) as resolve_model,
    ):
        payload = loop_item_execution_service.build_runtime_payload(
            test_db, execution=claimed
        )
    resolve_model.assert_called_once()
    model_config = payload["executionRequest"]["model_config"]
    assert model_config == full_config
    assert payload["executionRequest"]["enable_deep_thinking"] is False
    assert payload["modelId"] == "wework-gpt-5.6-sol"
    assert model_config["base_url"] == "https://gateway.example.com"
    assert model_config["model_id"] == "moonshot-kimi-k2.7-code-highspeed"
    assert model_config["upstream_api_format"] == "anthropic-messages"

    rotated_config = {**full_config, "api_key": "sk-rotated-at-dispatch"}
    with (
        patch.object(
            loop_item_execution_service,
            "_materialize_backend_request",
            return_value=True,
        ),
        patch(
            "app.services.chat.trigger.unified.build_wework_runtime_model_config",
            return_value=rotated_config,
        ),
    ):
        rebuilt = loop_item_execution_service.build_runtime_payload(
            test_db, execution=claimed
        )
    assert rebuilt["executionRequest"]["model_config"]["api_key"] == (
        "sk-rotated-at-dispatch"
    )
    assert claimed.execution_payload == ""


@pytest.mark.parametrize("executor_type", ["project_robot", "automation_manager"])
def test_local_runtime_payload_leaves_model_materialization_to_app(
    test_db: Session, test_user: User, executor_type: str
) -> None:
    """Every local Wework executor crosses claim with a model reference only."""

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "local-device", "local")
    if executor_type == "project_robot":
        bot = _make_bot(test_db, project, test_user)
        bot.device_id = "local-device"
        bot.metadata_json = {
            **dict(bot.metadata_json or {}),
            "execution_environment": "local",
            "model": "backend-visible-model",
        }
        test_db.commit()
        execution = loop_item_execution_service.create_for_assignment(
            test_db,
            loop_item_id=item.id,
            cloud_project_id=str(project.id),
            agent=bot,
            assigner_user_id=test_user.id,
            environment="local",
            execution_device_id="local-device",
            priority="medium",
        )
    else:
        rule = ProjectAutomationRule(
            id=f"custom-rule-{uuid.uuid4().hex[:10]}",
            cloud_project_id=project.id,
            title="Local custom automation",
            description="Handle the task",
            status="enabled",
            created_by_user_id=test_user.id,
            metadata_json={
                "assignment_mode": "ai_managed",
                "manager_type": "custom",
                "model": "backend-visible-model",
            },
        )
        test_db.add(rule)
        test_db.flush()
        run = ProjectAutomationRun(
            cloud_project_id=project.id,
            parent_id=rule.id,
            task_id=item.id,
            status="pending",
            created_by_user_id=test_user.id,
            metadata_json={"trigger": "manual"},
        )
        test_db.add(run)
        test_db.flush()
        execution = loop_item_execution_service.enqueue_automation_manager(
            test_db,
            loop_item_id=item.id,
            cloud_project_id=str(project.id),
            owner_user_id=test_user.id,
            assigner_user_id=test_user.id,
            environment="local",
            execution_device_id="local-device",
            priority="medium",
            automation_context={"run_id": str(run.id)},
        )
    test_db.commit()

    if executor_type == "project_robot":
        assert execution.agent_id == bot.id
        assert execution.automation_run_id == ""
    else:
        assert execution.agent_id == ""
        assert execution.automation_run_id == str(run.id)

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="local-device",
        environment="local",
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        owner_user_id=test_user.id,
    )
    assert claimed is not None
    assert claimed.id == execution.id
    with patch(
        "app.services.chat.trigger.unified.build_wework_runtime_model_config",
        side_effect=AssertionError("backend must not resolve a local model"),
    ) as resolve_model:
        payload = loop_item_execution_service.build_runtime_payload(
            test_db, execution=claimed
        )

    resolve_model.assert_not_called()
    assert payload["modelId"] == "backend-visible-model"
    assert "executionRequest" not in payload
    assert "model_config" not in str(payload)
    assert "api_key" not in str(payload)
    if executor_type == "automation_manager":
        assert f"project_id: {project.id}" in payload["message"]
        assert "你是看板的 AI 管家，只负责编排，不执行具体任务。" in payload["message"]
        assert "submit_workflow_plan" in payload["message"]
        assert f"task_id: {item.id}" in payload["message"]
        assert f"automation_run_id: {run.id}" in payload["message"]
        assert "Handle the task" in payload["message"]


def test_public_cloud_model_uses_backend_gateway_config(
    test_db: Session, test_user: User
) -> None:
    """Public cloud models (user_id=0 Model CRD) must route through the backend
    llm-responses-proxy gateway with the user token and model identity headers,
    exactly like the App's cloud-model send."""

    from app.models.kind import Kind

    test_db.add(
        Kind(
            kind="Model",
            name="public-cloud-model",
            namespace="default",
            user_id=0,
            is_active=True,
            json={
                "spec": {
                    "modelConfig": {
                        "env": {
                            "model": "claude",
                            "api_key": "secret-key",
                            "base_url": "https://gateway.example.com",
                            "model_id": "moonshot-kimi-k2.7-code-highspeed",
                        }
                    }
                }
            },
        )
    )
    test_db.commit()

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "model": "public-cloud-model",
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )
    assert claimed is not None

    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed
    )
    assert payload is not None
    model_config = payload["executionRequest"]["model_config"]
    assert "llm-responses-proxy" in model_config["base_url"]
    assert model_config["api_key"]
    headers = model_config["default_headers"]
    assert headers["X-Wegent-Model-Type"] == "public"
    assert headers["X-Wegent-Model-Namespace"] == "default"
    assert headers["X-Wegent-Model-User-Id"] == "0"
    assert model_config["upstream_api_format"] == "anthropic-messages"
    assert model_config["codex_catalog_model_id"] == "wework-kimi-k2-7"
    assert model_config["codex_responses_compat_proxy"] is True
    assert payload["modelId"] == "wework-kimi-k2-7"
    assert payload["executionRequest"]["enable_deep_thinking"] is False


def test_legacy_unbound_project_robot_is_claimed_by_its_owners_local_app(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Old Local Bot",
        name="Old Local Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="",
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    item = _make_item(test_db, project, test_user)
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        agent=bot,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id="",
        priority="medium",
    )
    test_db.commit()

    claimed = loop_item_execution_service.claim_next_unbound_local(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="local-device",
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
    )

    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.execution_device_id == "local-device"
    assert claimed.executor_owner_user_id == test_user.id


def test_automation_assignment_schedules_wegent_runtime_after_commit(
    test_db: Session,
    test_user: User,
    monkeypatch,
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    bot, team = _make_wegent_bot(test_db, project, test_user)
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Wegent automation",
        description="Run through the bound board robot.",
        status="enabled",
        assignee_agent_id=bot.id,
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "manual"},
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Wegent automation run",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "manual"},
    )
    test_db.add_all([rule, run])
    test_db.commit()
    schedule = MagicMock()
    monkeypatch.setattr(
        "app.services.board_team_execution.schedule_board_robot_execution",
        schedule,
    )

    project_automation_execution._assign_project_robot(
        test_db,
        owner=test_user,
        rule=rule,
        run=run,
        agent_id=bot.id,
        context={"run_id": str(run.id)},
        instruction="",
    )

    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(run.id))
        .one()
    )
    assert execution.status == "queued"
    assert execution.agent_id == bot.id
    assert execution.team_id == team.id
    schedule.assert_called_once_with(test_db, execution)


@pytest.mark.asyncio
async def test_wegent_runtime_activation_uses_exact_execution_and_is_idempotent(
    test_db: Session,
    test_user: User,
    monkeypatch,
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    bot, team = _make_wegent_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "system_prompt": "Robot-defined execution prompt.",
    }
    test_db.commit()
    from app.services.loop_items.service import loop_item_service

    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            assignee_type="agent",
            assignee_id=bot.id,
            version=item.version,
        ),
    )
    execution = (
        test_db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.agent_id == bot.id,
        )
        .one()
    )

    async def persist_backend_task(**kwargs) -> None:
        kwargs["db"].get(
            LoopItemExecution, kwargs["execution_id"]
        ).backend_task_id = 1234
        kwargs["db"].commit()

    dispatch = AsyncMock(side_effect=persist_backend_task)
    monkeypatch.setattr(
        "app.services.board_team_execution."
        "project_automation_managed_execution_service.dispatch_board_team",
        dispatch,
    )

    activated = await dispatch_board_robot_execution(test_db, execution_id=execution.id)
    repeated = await dispatch_board_robot_execution(test_db, execution_id=execution.id)

    assert activated is not None
    assert activated.backend_task_id == 1234
    assert repeated is not None
    assert repeated.backend_task_id == 1234
    dispatch.assert_awaited_once()
    assert dispatch.await_args.kwargs["execution_id"] == execution.id
    assert dispatch.await_args.kwargs["agent"].id == bot.id
    assert dispatch.await_args.kwargs["team"].id == team.id
    assert dispatch.await_args.kwargs["owner"].id == test_user.id
    prompt = dispatch.await_args.kwargs["prompt"]
    assert prompt == (
        f"project_id: {project.id}\n"
        f"task_id: {item.id}\n"
        f"execution_id: {execution.id}\n\n"
        f"看板任务数据位于 cloud://projects/{project.id}/todos/{item.id}，"
        "请通过看板工具自行查看。\n\n"
        "Robot-defined execution prompt."
    )


def test_wegent_runtime_enqueue_failure_does_not_leave_execution_queued(
    test_db: Session,
    test_user: User,
    monkeypatch,
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    bot, _ = _make_wegent_bot(test_db, project, test_user)
    from app.services.board_team_execution import schedule_board_robot_execution
    from app.services.loop_items.service import loop_item_service

    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            assignee_type="agent",
            assignee_id=bot.id,
            version=item.version,
        ),
    )
    execution = (
        test_db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.agent_id == bot.id,
        )
        .one()
    )
    monkeypatch.setattr(
        "app.tasks.project_automation_tasks." "dispatch_board_robot_execution.delay",
        MagicMock(side_effect=RuntimeError("broker unavailable")),
    )

    with pytest.raises(RuntimeError, match="broker unavailable"):
        schedule_board_robot_execution(test_db, execution)

    test_db.refresh(execution)
    assert execution.status == "failed"
    assert execution.termination_reason == ("wegent_runtime_activation_enqueue_failed")


def test_custom_manager_assignment_survives_manager_transport_failure(
    test_db: Session, test_user: User
) -> None:
    """The MCP assignment, not the manager's final text, is authoritative."""

    from app.services.project_chat.service import project_chat_service

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user, title="Managed task")
    item.description = "Implement the task described by the product owner."
    # Newly created tasks may initially belong to their creator. The manager's
    # MCP assignment must be allowed to replace that default ownership.
    item.assignee_user_id = test_user.id
    agent = _make_bot(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose the project robot with the closest responsibility.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
            "model": "test-model",
            "execution_environment": "cloud",
            "execution_device_id": "cloud-device-1",
        },
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        description="",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger": "task_created",
            "event": {"type": "task.created", "task_id": item.id},
        },
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"automation_manager:{rule.id}",
        sender_name="自定义 AI 调度员",
        message_type="agent_status",
        content="",
        metadata_json={
            "kind": "project_automation_run",
            "automation_run_id": str(run.id),
            "run_status": "queued",
        },
        agent_id="",
        status="pending",
    )
    test_db.add_all([rule, run, activity])
    test_db.flush()
    run.metadata_json = {
        **run.metadata_json,
        "activity_message_id": message_id,
    }
    manager_execution = loop_item_execution_service.enqueue_automation_manager(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="high",
        automation_context={
            "rule_id": str(rule.id),
            "run_id": str(run.id),
            "trigger": "task_created",
            "event": {"type": "task.created", "task_id": item.id},
            "activity_message_id": message_id,
        },
    )
    activity.metadata_json = {
        **activity.metadata_json,
        "execution_id": manager_execution.id,
    }
    test_db.commit()

    assigned = project_automation_execution.assign_from_manager(
        test_db,
        run_id=str(run.id),
        user_id=test_user.id,
        project_id=str(project.id),
        task_id=item.id,
        assignee_type="agent",
        assignee_id=agent.id,
    )
    assert assigned["assignee_agent_id"] == agent.id
    repeated = project_automation_execution.assign_from_manager(
        test_db,
        run_id=str(run.id),
        user_id=test_user.id,
        project_id=str(project.id),
        task_id=item.id,
        assignee_type="agent",
        assignee_id=agent.id,
    )
    assert repeated["assignee_agent_id"] == agent.id
    with pytest.raises(RuntimeError, match="already selected another assignee"):
        project_automation_execution.assign_from_manager(
            test_db,
            run_id=str(run.id),
            user_id=test_user.id,
            project_id=str(project.id),
            task_id=item.id,
            assignee_type="user",
            assignee_id=str(test_user.id),
        )

    manager_result = loop_item_execution_service.fail(
        test_db,
        execution_id=manager_execution.id,
        error="Manager result transport closed after the MCP assignment",
    )

    assert manager_result is not None
    assert manager_result.status == "failed"
    test_db.refresh(item)
    test_db.refresh(run)
    test_db.refresh(activity)
    assert item.assignee_agent_id == agent.id
    assert item.status != "in_review"
    assert "ai_state" not in dict(item.metadata_json or {})
    assert run.status == "succeeded"
    assert run.assignee_agent_id == agent.id
    assert activity.status == "completed"
    assert activity.sender_id == f"automation_manager:{rule.id}"
    assert activity.sender_name == "自定义 AI 调度员"
    assert activity.agent_id == ""
    assert activity.metadata_json["selected_assignee_type"] == "agent"
    assert activity.metadata_json["selected_assignee_id"] == agent.id
    assert activity.metadata_json["transport_error"].startswith(
        "Manager result transport closed"
    )
    assert activity.content.startswith("AI 调度员已完成分派")

    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(run.id))
        .order_by(LoopItemExecution.id)
        .all()
    )
    assert [row.executor_type for row in executions] == [
        "automation_manager",
        "project_robot",
    ]
    robot_execution = executions[1]
    assert robot_execution.agent_id == agent.id
    assert robot_execution.status == "queued"

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        runtime_instance_id="runtime-1",
        device_capacity=1,
        runtime_active=0,
        runtime_active_task_ids=set(),
        owner_user_id=test_user.id,
    )
    assert claimed is not None and claimed.id == robot_execution.id
    robot_activity = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    assert robot_activity is not None
    assert robot_activity.message_id != activity.message_id
    assert robot_activity.agent_id == agent.id
    robot_activity_row = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.message_id == robot_activity.message_id)
        .one()
    )
    assert not project_chat_service._project_automation_activity_is_terminal(
        test_db, robot_activity_row
    )
    test_db.refresh(item)
    assert item.status == "inbox"

    completed = loop_item_execution_service.complete(
        test_db,
        execution_id=claimed.id,
        content="Project robot completed the assigned task.",
    )
    assert completed is not None and completed.status == "completed"
    test_db.refresh(item)
    test_db.refresh(run)
    assert item.status == "in_review"
    assert run.status == "succeeded"
    status_history = item.metadata_json.get("status_history", [])
    assert status_history[-1]["to_status"] == "in_review"
    assert status_history[-1]["trigger"] == "ai_completed"


def test_manager_assigns_project_member_without_parsing_final_output(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user, title="Product decision")
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose by project capability.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "custom"},
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "task_created"},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"automation_manager:{rule.id}",
        sender_name="自定义 AI 调度员",
        message_type="agent_status",
        content="",
        metadata_json={
            "kind": "project_automation_run",
            "automation_run_id": str(run.id),
            "run_status": "running",
        },
        agent_id="",
        status="streaming",
    )
    run.metadata_json = {
        **run.metadata_json,
        "activity_message_id": message_id,
    }
    test_db.add_all([rule, run, activity])
    test_db.commit()

    project_automation_execution.assign_from_manager(
        test_db,
        run_id=str(run.id),
        user_id=test_user.id,
        project_id=str(project.id),
        task_id=item.id,
        assignee_type="user",
        assignee_id=str(test_user.id),
    )
    test_db.refresh(run)
    assert run.status == "running"
    project_automation_execution.finalize_manager_result(
        test_db,
        run_id=str(run.id),
        content='This is not assignment JSON and is never parsed: {"wrong": true}',
    )

    test_db.refresh(item)
    test_db.refresh(run)
    assert item.assignee_user_id == test_user.id
    assert item.assignee_agent_id in (None, "")
    assert run.status == "succeeded"
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(run.id))
        .count()
        == 0
    )
    assert run.status == "succeeded"


def test_completed_manager_comment_repairs_stale_queued_rule_run(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    agent = _make_bot(test_db, project, test_user)
    item.assignee_agent_id = agent.id
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Wegent dispatcher",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "wegent"},
    )
    run = ProjectAutomationRun(
        id=f"run-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Stale queued run",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id="wegent_team:1",
        sender_name="Wegent dispatcher",
        message_type="text",
        content="Assigned to the backend robot.",
        metadata_json={
            "automation_run_id": str(run.id),
            "run_status": "completed",
            "selected_assignee_type": "agent",
            "selected_assignee_id": agent.id,
        },
        status="completed",
    )
    test_db.add_all([rule, run, activity])
    test_db.flush()
    run.metadata_json = {"activity_message_id": message_id}
    test_db.commit()
    _make_execution(
        test_db,
        item,
        agent,
        test_user,
        automation_context={"run_id": str(run.id)},
    )

    changed = project_automation_execution.finalize_manager_result(
        test_db,
        run_id=str(run.id),
        content=None,
        push_activity=False,
    )

    test_db.refresh(run)
    assert changed is True
    assert run.status == "succeeded"
    assert run.completed_at is not None


def test_manager_does_not_treat_default_creator_as_a_submitted_plan(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user, title="New task")
    item.assignee_user_id = test_user.id
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose by capability.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "custom"},
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "task_created"},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"automation_manager:{rule.id}",
        sender_name="自定义 AI 调度员",
        message_type="agent_status",
        content="",
        metadata_json={"automation_run_id": str(run.id), "run_status": "running"},
        agent_id="",
        status="streaming",
    )
    run.metadata_json = {
        **run.metadata_json,
        "activity_message_id": message_id,
    }
    test_db.add_all([rule, run, activity])
    test_db.commit()

    project_automation_execution.finalize_manager_result(
        test_db,
        run_id=str(run.id),
        content='Suggested assignment text: {"assignee_id": 1}',
    )

    test_db.refresh(run)
    test_db.refresh(activity)
    test_db.refresh(item)
    assert item.assignee_user_id == test_user.id
    assert run.status == "failed"
    assert activity.status == "failed"
    assert activity.metadata_json.get("selected_assignee_id") is None


def test_manager_completion_recovers_persisted_workflow_plan_binding(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user, title="Planned task")
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed planning",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "custom"},
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        description="AI manager finished without submitting a workflow plan.",
        status="failed",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"automation_manager:{rule.id}",
        sender_name="自定义 AI 调度员",
        message_type="agent_status",
        content="",
        metadata_json={"automation_run_id": str(run.id), "run_status": "failed"},
        status="failed",
    )
    test_db.add_all([rule, run, activity])
    test_db.flush()
    workflow_run = ProjectWorkflowRun(
        cloud_project_id=project.id,
        parent_id=item.id,
        title="Versioned plan",
        description="Implement and verify.",
        status="awaiting_approval",
        source="ai",
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
        metadata_json={
            "plan_version": 2,
        },
    )
    test_db.add(workflow_run)
    test_db.flush()
    test_db.add(
        ProjectWorkflowPlanItem(
            cloud_project_id=project.id,
            parent_id=workflow_run.id,
            title="Implement the plan",
            description="Implement and verify.",
            status="proposed",
            created_by_user_id=test_user.id,
            updated_by_user_id=test_user.id,
            metadata_json={
                "client_key": "implement",
                "stage_id": "__issue__",
                "title": "Implement the plan",
                "description": "Implement and verify.",
                "assignee_type": "user",
                "assignee_id": str(test_user.id),
                "assignee_name": test_user.user_name,
                "rationale": "Owner verification",
            },
        )
    )
    run.metadata_json = {
        "activity_message_id": message_id,
        "event": {"payload": {"workflow_run_id": workflow_run.id}},
    }
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": {
            "active_run_id": workflow_run.id,
            "approval_policy": "required",
            "orchestration_status": "awaiting_approval",
        },
    }
    test_db.commit()

    before_repair = issue_workflow_planning_service.get(
        test_db,
        issue_id=item.id,
        user_id=test_user.id,
    )

    test_db.refresh(run)
    test_db.refresh(activity)
    test_db.refresh(workflow_run)
    assert before_repair is not None
    assert before_repair.manager_run is not None
    assert before_repair.manager_run.status == "failed"
    assert run.status == "failed"
    assert activity.status == "failed"
    assert activity.metadata_json.get("workflow_plan_run_id") is None
    assert workflow_run.metadata_json.get("project_automation_run_id") is None

    project_automation_execution.finalize_manager_result(
        test_db,
        run_id=run.id,
        content="Plan submitted.",
    )
    plan = issue_workflow_planning_service.get(
        test_db,
        issue_id=item.id,
        user_id=test_user.id,
    )

    test_db.refresh(run)
    test_db.refresh(activity)
    test_db.refresh(workflow_run)
    assert plan is not None
    assert plan.manager_run is not None
    assert plan.manager_run.status == "succeeded"
    assert run.status == "succeeded"
    assert activity.status == "completed"
    assert activity.metadata_json["workflow_plan_run_id"] == workflow_run.id
    assert activity.metadata_json["workflow_plan_version"] == 2
    assert workflow_run.metadata_json["project_automation_run_id"] == run.id


def test_manager_completion_rejects_empty_trigger_created_workflow_run(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user, title="Unsubmitted plan")
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed planning",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"assignment_mode": "ai_managed", "manager_type": "custom"},
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    activity_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=activity_id,
        client_message_id=activity_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"automation_manager:{rule.id}",
        sender_name="自定义 AI 调度员",
        message_type="agent_status",
        content="",
        metadata_json={"automation_run_id": str(run.id), "run_status": "running"},
        status="streaming",
    )
    workflow_run = ProjectWorkflowRun(
        cloud_project_id=project.id,
        parent_id=item.id,
        title="Empty planning run",
        status="planning",
        source="ai",
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
        metadata_json={"plan_version": 1},
    )
    test_db.add_all([rule, run, activity, workflow_run])
    test_db.flush()
    run.metadata_json = {
        "activity_message_id": activity_id,
        "event": {"payload": {"workflow_run_id": workflow_run.id}},
    }
    test_db.commit()

    project_automation_execution.finalize_manager_result(
        test_db,
        run_id=str(run.id),
        content="Prepared a draft but did not submit it.",
        push_activity=False,
    )

    test_db.refresh(run)
    test_db.refresh(activity)
    assert run.status == "failed"
    assert run.description == "AI manager finished without submitting a workflow plan."
    assert activity.status == "failed"


@pytest.mark.asyncio
async def test_cancel_stops_selected_robot_before_terminal_wegent_manager_task(
    test_db: Session, test_user: User
) -> None:
    """A retained manager Task id must not hide the active business executor."""

    from app.services.project_automations import project_automation_service

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    agent = _make_bot(test_db, project, test_user)
    rule = ProjectAutomationRule(
        id=f"rule-{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Managed assignment",
        description="Choose a project robot.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "assignment_mode": "ai_managed",
            "manager_type": "wegent",
            "timezone": "Asia/Shanghai",
        },
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        title="Managed run",
        status="queued",
        backend_task_id=777,
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "task_created"},
    )
    test_db.add_all([rule, run])
    test_db.flush()
    execution = _make_execution(
        test_db,
        item,
        agent,
        test_user,
        automation_context={"run_id": str(run.id)},
    )

    with patch(
        "app.services.project_automation_managed_execution."
        "project_automation_managed_execution_service.cancel",
        new_callable=AsyncMock,
    ) as cancel_manager:
        view = await project_automation_service.cancel_run(
            test_db,
            str(project.id),
            str(run.id),
            test_user.id,
        )

    test_db.refresh(execution)
    test_db.refresh(run)
    assert execution.status == "cancelled"
    assert run.status == "cancelled"
    assert view["status"] == "cancelled"
    cancel_manager.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_running_automation_requires_runtime_confirmation(
    test_db: Session,
    test_user: User,
) -> None:
    """A pause must not report success while the Runtime task is still active."""

    from app.services.project_automations import project_automation_service

    execution, run, _ = _make_running_automation_execution(test_db, test_user)
    execution_id = execution.id

    with patch(
        "app.tasks.robot_queue_tasks.emit_runtime_cancels",
        return_value=set(),
    ):
        with pytest.raises(HTTPException) as error:
            await project_automation_service.cancel_run(
                test_db,
                str(execution.cloud_project_id),
                str(run.id),
                test_user.id,
            )

    assert error.value.status_code == 502
    assert error.value.detail == "Runtime did not confirm cancellation"
    execution = test_db.get(LoopItemExecution, execution_id)
    assert execution is not None
    test_db.refresh(run)
    assert execution.status == "cancel_requested"
    assert run.status == "running"


def test_cloud_execution_fails_when_selected_model_no_longer_exists(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")
    rule = ProjectAutomationRule(
        id="deleted-model-rule",
        cloud_project_id=project.id,
        title="Deleted model rule",
        description="Handle this task",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
            "model": "deleted-model",
        },
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "manual"},
    )
    test_db.add_all([rule, run])
    test_db.flush()
    execution = loop_item_execution_service.enqueue_automation_manager(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="medium",
        automation_context={"run_id": str(run.id)},
    )
    test_db.commit()

    with pytest.raises(
        WeworkRuntimeConfigurationError,
        match="Execution model 'deleted-model' is unavailable",
    ):
        loop_item_execution_service.build_runtime_payload(
            test_db,
            execution=execution,
        )


def test_cancel_queued_execution_closes_linked_activity_without_runtime_device(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        task_id=item.id,
        title="Managed run",
        description="",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project.id),
        task_id=item.id,
        sender_type="agent",
        sender_id="automation_manager:rule-2",
        sender_name="自定义 AI 调度员",
        message_type="agent_chunk",
        content="",
        metadata_json={"run_status": "pending"},
        status="pending",
    )
    test_db.add_all([run, activity])
    test_db.commit()
    rule = ProjectAutomationRule(
        id="rule-2",
        cloud_project_id=project.id,
        title="Process event",
        description="Process the event.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
            "model": "test-model",
        },
    )
    run.parent_id = rule.id
    run.metadata_json = {
        "trigger": "manual",
        "activity_message_id": message_id,
    }
    test_db.add(rule)
    test_db.commit()
    execution = loop_item_execution_service.enqueue_automation_manager(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="medium",
        automation_context={
            "run_id": str(run.id),
            "activity_message_id": message_id,
        },
    )
    activity.metadata_json = {
        **activity.metadata_json,
        "execution_id": execution.id,
    }
    test_db.commit()
    assert not execution.runtime_device_id

    with patch(
        "app.services.project_chat.push.push_project_chat_message"
    ) as push_message:
        cancelled = loop_item_execution_service.cancel(
            test_db, execution_id=execution.id, note="Stopped by user"
        )

    test_db.refresh(activity)
    test_db.refresh(run)
    assert cancelled.status == "cancelled"
    assert activity.status == "cancelled"
    assert activity.metadata_json["run_status"] == "cancelled"
    assert run.status == "cancelled"
    push_message.assert_called_once()
