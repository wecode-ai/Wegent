# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for robot queue execution records (claim/capacity/lease)."""

import uuid
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)


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


def _make_execution(
    db: Session,
    item: LoopItem,
    bot: ProjectChatAgent,
    user: User,
    *,
    priority: str = "medium",
) -> LoopItemExecution:
    execution = loop_item_execution_service.create_for_assignment(
        db,
        loop_item_id=item.id,
        cloud_project_id=item.cloud_project_id,
        agent=bot,
        assigner_user_id=user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority=priority,
    )
    db.commit()
    db.refresh(execution)
    return execution


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
    )
    assert claimed is not None
    assert claimed.id == first.id
    assert claimed.status == "running"
    assert claimed.lease_expires_at is not None

    # A robot only runs one task at a time, so the second stays queued.
    blocked = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
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
    )
    assert first is not None
    # Device capacity is 1: the second robot cannot start on the same device.
    blocked = loop_item_execution_service.claim(
        test_db,
        agent_id=bot_b.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
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
    )
    assert claimed is not None
    refreshed = loop_item_execution_service.heartbeat(
        test_db,
        execution_id=claimed.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id="codex-robot-1",
    )
    assert refreshed is not None
    assert refreshed.runtime_task_id == "codex-robot-1"
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
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=claimed.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id="codex-robot-1",
    )
    original_lease = claimed.lease_expires_at

    refreshed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id="codex-robot-1",
        event_name="response.output_text.delta",
        payload={"data": {"delta": "tick"}},
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
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=execution.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id="codex-robot-completed",
    )

    completed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id="codex-robot-completed",
        event_name="response.completed",
        payload={"data": {}},
    )

    assert completed is not None
    assert completed.status == "completed"
    test_db.refresh(run)
    assert run.status == "succeeded"
    assert run.completed_at is not None
    # A successful run without spawned child tasks must not inherit the
    # bug-scan wording ("No bugs found.").
    assert run.description == ""


def test_automation_summary_is_generic_with_child_tasks(
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
    child_execution = _make_execution(test_db, child, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=child_execution.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id="codex-robot-child",
    )

    completed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id="codex-robot-child",
        event_name="response.completed",
        payload={"data": {}},
    )

    assert completed is not None
    assert completed.status == "completed"
    test_db.refresh(run)
    assert run.status == "succeeded"
    assert run.description == "Completed 1 child task(s)."


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


def test_lease_expiry_recovery_requeues_then_fails(
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
        lease_seconds=60,
    )
    assert claimed is not None
    expired = claimed.lease_expires_at - timedelta(seconds=120)
    claimed.lease_expires_at = expired
    test_db.commit()

    requeued, failed = loop_item_execution_service.recovery_scan(
        test_db,
        now=claimed.lease_expires_at + timedelta(seconds=120),
        lease_seconds=60,
    )
    assert (requeued, failed) == (1, 0)
    test_db.refresh(claimed)
    assert claimed.status == "queued"
    assert claimed.retry_attempt == 1

    # Second claim, expire again: retry budget is exhausted -> failed.
    re_claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        lease_seconds=60,
    )
    assert re_claimed is not None
    re_claimed.lease_expires_at = re_claimed.lease_expires_at - timedelta(seconds=120)
    test_db.commit()
    requeued, failed = loop_item_execution_service.recovery_scan(
        test_db,
        now=re_claimed.lease_expires_at + timedelta(seconds=120),
        lease_seconds=60,
    )
    assert (requeued, failed) == (0, 1)
    test_db.refresh(re_claimed)
    assert re_claimed.status == "failed"
    assert "lease" in re_claimed.error_message


def test_stall_scan_fails_runs_without_ai_output(
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
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=claimed.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id="codex-robot-stall",
    )
    claimed.started_at = claimed.started_at - timedelta(minutes=30)
    test_db.commit()
    test_db.add(
        ProjectChatMessage(
            message_id="stall-msg-1",
            client_message_id="stall-msg-1",
            project_id=str(project.id),
            task_id=claimed.loop_item_id,
            sender_type="agent",
            sender_id=bot.id,
            sender_name="Queue Bot",
            message_type="agent_chunk",
            content="",
            agent_id=bot.id,
            runtime_device_id="cloud-device-1",
            runtime_task_id="codex-robot-stall",
            status="streaming",
        )
    )
    test_db.commit()

    stalled = loop_item_execution_service.stall_scan(
        test_db, text_timeout_seconds=20 * 60
    )
    assert [run.id for run in stalled] == [claimed.id]
    test_db.refresh(claimed)
    assert claimed.status == "failed"
    assert "未产生任何输出" in claimed.error_message


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
    )
    assert claimed is not None
    loop_item_execution_service.heartbeat(
        test_db,
        execution_id=claimed.id,
        runtime_device_id="cloud-device-1",
        runtime_task_id="codex-robot-text",
    )
    claimed.started_at = claimed.started_at - timedelta(minutes=30)
    test_db.commit()
    test_db.add(
        ProjectChatMessage(
            message_id="text-msg-1",
            client_message_id="text-msg-1",
            project_id=str(project.id),
            task_id=claimed.loop_item_id,
            sender_type="agent",
            sender_id=bot.id,
            sender_name="Queue Bot",
            message_type="agent_chunk",
            content="real progress text",
            agent_id=bot.id,
            runtime_device_id="cloud-device-1",
            runtime_task_id="codex-robot-text",
            status="streaming",
        )
    )
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

    with pytest.raises(HTTPException, match="Only the robot creator"):
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
    """A claimed cloud run must produce the runtime.tasks.create payload the
    executor replays: the prompt is the robot role description, and the task
    content is left for the AI to read through wework_space."""

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
    )
    assert claimed is not None

    task = loop_item_execution_service.resolve_task_context(
        test_db, execution=claimed, user_id=test_user.id
    )
    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed, task=task
    )
    assert payload is not None
    execution_request = payload.get("executionRequest")
    assert isinstance(execution_request, dict)
    assert execution_request["task_id"]
    assert execution_request["bot"][0]["id"] == bot.id
    assert (
        "Verify before reporting completion"
        in execution_request["bot"][0]["system_prompt"]
    )
    assert "你是" in execution_request["prompt"]
    assert "Build the landing page" not in execution_request["prompt"]
    assert "Create three subtasks for testing." not in execution_request["prompt"]
    assert "Verify before reporting completion" in execution_request["prompt"]
    assert execution_request["prompt"] == payload["message"]
    project_chat = payload["additionalContext"]["projectChat"]["value"]
    assert "get_board_item" in project_chat
    assert "do not call list_spaces" in project_chat
    assert f"/todos/{item.id}" in project_chat
    assert payload["cloudProjectId"] == str(project.id)
    assert "ephemeral" not in payload
    assert "continuable" not in payload
    assert payload["runtime"] == "codex"


def test_runtime_payload_uses_robot_bound_local_project() -> None:
    from types import SimpleNamespace

    payload = loop_item_execution_service._build_runtime_payload(
        item=SimpleNamespace(
            id="item-1",
            cloud_project_id="project-1",
            title="Bound task",
            local_project_id=0,
        ),
        agent=SimpleNamespace(
            id="agent-1",
            title="Robot",
            name="Robot",
            local_project_id=91,
            device_id=None,
            metadata_json={},
        ),
        creator=SimpleNamespace(id=1, user_name="tester"),
        team=None,
        prompt="Run task",
        runtime_task_id="runtime-task-1",
    )

    assert payload["local_project_id"] == 91
    assert payload["executionRequest"]["standalone_chat_workspace"] is False


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
    )
    assert claimed is not None
    assert claimed.runtime_task_id == f"codex-queue-{claimed.id}"
    assert claimed.runtime_device_id == "cloud-device-1"

    task = loop_item_execution_service.resolve_task_context(
        test_db, execution=claimed, user_id=test_user.id
    )
    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed, task=task
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
    )
    assert claimed is not None

    first = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    second = loop_item_execution_service.open_execution_activity(
        test_db, execution=claimed
    )
    assert first is not None and second is not None
    assert first.message_id == second.message_id
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
    assert messages[0].status == "streaming"
    assert messages[0].runtime_task_id == f"codex-queue-{claimed.id}"


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
    )
    assert claimed is not None

    result = project_chat_service.project_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=claimed.runtime_task_id,
        event_name="response.output_text.delta",
        payload={"data": {"delta": "hello from the executor"}},
    )
    assert result is not None
    message, mode = result
    assert mode == "delta"
    assert message.content == "hello from the executor"


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
    assert first.message_id != second.message_id

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


def test_automation_run_uses_the_same_generic_project_context_as_other_tasks(
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
        test_db, execution=execution, task=task
    )
    assert payload is not None
    project_chat = payload["additionalContext"]["projectChat"]["value"]
    assert "get_board_item" in project_chat
    assert "report_automation_bug" not in project_chat
    assert "automation scan" not in project_chat
    assert "run-123" not in project_chat


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
        device_capacity=4,
        batch_size=4,
    )
    assert len(claimed) == 1
    assert claimed[0].id == first.id
    test_db.refresh(second)
    assert second.status == "queued"


def test_mark_running_advances_claimed_only(test_db: Session, test_user: User) -> None:
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
        device_capacity=2,
        batch_size=2,
    )
    assert len(claimed) == 1
    # second is still queued; mark_running must not touch it.
    advanced = loop_item_execution_service.mark_running(
        test_db,
        execution_ids=[claimed[0].id, second.id],
    )
    assert advanced == 1
    test_db.refresh(claimed[0])
    test_db.refresh(second)
    assert claimed[0].status == "running"
    assert second.status == "queued"


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


def test_claimed_run_builds_complete_model_config_matching_app_send(
    test_db: Session, test_user: User
) -> None:
    """build_runtime_payload must emit the same complete Codex model config the
    App sends for a cloud/public model (gateway base_url, api_key, headers and
    the mapped gateway model id), not just the display model name."""

    from unittest.mock import patch

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "model": "wecode-moonshot-kimi-k2.7-code-highspeed(公网)",
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
    )
    assert claimed is not None

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
        "app.services.chat.trigger.unified._build_codex_runtime_model_config",
        return_value=full_config,
    ):
        task = loop_item_execution_service.resolve_task_context(
            test_db, execution=claimed, user_id=test_user.id
        )
        payload = loop_item_execution_service.build_runtime_payload(
            test_db, execution=claimed, task=task
        )
    assert payload is not None
    model_config = payload["executionRequest"]["model_config"]
    assert model_config == full_config
    assert payload["executionRequest"]["enable_deep_thinking"] is False
    assert payload["modelId"] == "wework-gpt-5.6-sol"
    assert model_config["base_url"] == "https://gateway.example.com"
    assert model_config["model_id"] == "moonshot-kimi-k2.7-code-highspeed"
    assert model_config["upstream_api_format"] == "anthropic-messages"


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
    )
    assert claimed is not None

    task = loop_item_execution_service.resolve_task_context(
        test_db, execution=claimed, user_id=test_user.id
    )
    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed, task=task
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


def test_unbound_local_robot_can_be_claimed_by_creator_device(
    test_db: Session, test_user: User
) -> None:
    """Robots created before device binding have no device; the creator's
    local device can still claim and bind them."""

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
    assert execution.execution_device_id == ""

    claimed = loop_item_execution_service.claim_next_unbound_local(
        test_db,
        creator_user_id=test_user.id,
        execution_device_id="local-device",
    )
    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.execution_device_id == "local-device"
    assert claimed.status == "running"
