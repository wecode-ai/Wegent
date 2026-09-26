# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for robot queue execution records (claim/capacity/lease)."""

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import app.core.async_utils as async_utils
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
    RuntimeProfile,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project import Project
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.project_chat import LoopItemAssign
from app.schemas.runtime_profile import RuntimeProfileCreate
from app.services import execution_environment_initialization
from app.services.device.runtime_route import runtime_device_route_id
from app.services.issue_execution_configuration import (
    execution_context,
    project_robot_execution_config,
)
from app.services.loop_item_executions.profile import (
    WeworkExecutionProfile,
    WeworkExecutionProfileError,
)
from app.services.loop_item_executions.service import (
    TaskContext,
    WeworkRuntimeConfigurationError,
    execution_display_state,
    loop_item_execution_service,
    runtime_task_id_for,
    utcnow,
)
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.project_automation_execution import project_automation_execution
from app.services.runtime_profiles import runtime_profile_service
from tests.utils.devices import SHARED_APP_DEVICE_ID, create_app_device


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
            "capability_mode": "manual",
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
    return _make_native_team_binding(db, project, user, shell_type="Chat")


def _make_native_team_binding(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    shell_type: str,
) -> tuple[ProjectChatAgent, Kind]:
    suffix = uuid.uuid4().hex[:8]
    skill = Kind(
        kind="Skill",
        name=f"review-skill-{suffix}",
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {
                "name": f"review-skill-{suffix}",
                "namespace": "default",
            },
            "spec": {
                "description": "Review the project result.",
                "prompt": "Review every changed file.",
                "bindShells": [shell_type],
            },
        },
    )
    db.add(skill)
    db.flush()
    ghost_name = f"native-ghost-{suffix}"
    ghost = Kind(
        kind="Ghost",
        name=ghost_name,
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": ghost_name, "namespace": "default"},
            "spec": {
                "systemPrompt": "Follow the referenced AgentSpec.",
                "skills": [skill.name],
                "skill_refs": {
                    skill.name: {
                        "skill_id": skill.id,
                        "namespace": "default",
                        "is_public": False,
                    }
                },
                "mcpServers": {
                    "repo": {
                        "command": "node",
                        "args": ["repo-server.mjs"],
                    }
                },
            },
        },
    )
    shell = Kind(
        kind="Shell",
        name=f"{shell_type}-{suffix}",
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": f"{shell_type}-{suffix}",
                "namespace": "default",
            },
            "spec": {
                "shellType": shell_type,
                "baseImage": "native-runtime:test",
            },
            "status": {"state": "Available"},
        },
    )
    model = Kind(
        kind="Model",
        name=f"native-model-{suffix}",
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": f"native-model-{suffix}",
                "namespace": "default",
            },
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "claude" if shell_type == "ClaudeCode" else "codex",
                        "model_id": f"runtime-model-{suffix}",
                        "api_key": "test-key",
                        "base_url": "https://gateway.example.test",
                    }
                }
            },
        },
    )
    db.add_all([ghost, shell, model])
    db.flush()
    bot_name = f"native-bot-{suffix}"
    native_bot = Kind(
        kind="Bot",
        name=bot_name,
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": bot_name, "namespace": "default"},
            "spec": {
                "ghostRef": {"name": ghost.name, "namespace": "default"},
                "shellRef": {"name": shell.name, "namespace": "default"},
                "modelRef": {"name": model.name, "namespace": "default"},
                "capability_mode": "manual",
            },
        },
    )
    db.add(native_bot)
    db.flush()
    team_name = f"native-team-{suffix}"
    team = Kind(
        kind="Team",
        name=team_name,
        namespace="default",
        user_id=user.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": team_name, "namespace": "default"},
            "spec": {
                "collaborationModel": "solo",
                "members": [
                    {
                        "botRef": {
                            "name": native_bot.name,
                            "namespace": "default",
                        },
                        "prompt": "Apply the project-specific responsibility.",
                        "role": "worker",
                    }
                ],
            },
        },
    )
    db.add(team)
    db.flush()
    binding = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title=f"{shell_type} Agent",
        name=f"{shell_type} Agent",
        status="active",
        created_by_user_id=user.id,
        device_id=None,
        metadata_json={
            "runtime": "wegent",
            "wegent_team_id": team.id,
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    db.add(binding)
    db.commit()
    db.refresh(binding)
    db.refresh(team)
    return binding, team


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


def _automation_metadata(
    *,
    agent_id: str | None = None,
    **extra: object,
) -> dict:
    metadata = {
        "dispatch_target": {
            "kind": "agent" if agent_id else "human",
            "id": agent_id or "1",
            "name": "Automation target",
        },
        "role": {
            "source": "agent" if agent_id else "generic",
            "agent_id": agent_id,
        },
        "runtime": {
            "source": "agent_default" if agent_id else "issue_creator",
            "runtime_profile_id": None,
            "user_id": None,
        },
        **extra,
    }
    return metadata


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


def _authorize_project_device(
    db: Session,
    project: CloudProject,
    device: Kind,
    user: User,
) -> None:
    db.add(
        ResourceMember(
            resource_type=ResourceType.DEVICE.value,
            resource_id=device.id,
            entity_type="project",
            entity_id=str(project.id),
            role=BaseRole.Developer.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=user.id,
        )
    )
    db.commit()


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
    metadata = dict(bot.metadata_json or {})
    model_name = str(metadata.get("model") or "test-model")
    model = (
        db.query(Kind)
        .filter(
            Kind.kind == "Model",
            Kind.namespace == "default",
            Kind.name == model_name,
            Kind.user_id == 0,
        )
        .one_or_none()
    )
    if model is None:
        db.add(
            Kind(
                kind="Model",
                name=model_name,
                namespace="default",
                user_id=0,
                is_active=True,
                json={
                    "spec": {
                        "modelConfig": {
                            "env": {
                                "model": "claude",
                                "api_key": "test-key",
                                "base_url": "https://gateway.example.com",
                                "model_id": model_name,
                            }
                        }
                    }
                },
            )
        )
        db.flush()
    if metadata.get("runtime") == "codex" and not metadata.get(
        "default_runtime_profile_id"
    ):
        profile = RuntimeProfile(
            user_id=user.id,
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
            name=f"{bot.name} Runtime",
            title=f"{bot.name} Runtime",
            device_id="cloud-device-1",
            metadata_json={
                "execution_environment": "cloud",
                "model": model_name,
                "model_options": {},
                "workspace_policy": "project",
            },
        )
        db.add(profile)
        db.flush()
        metadata["default_runtime_profile_id"] = profile.id
        bot.metadata_json = metadata
        bot.device_id = None
        db.flush()
    elif metadata.get("default_runtime_profile_id"):
        profile = db.get(RuntimeProfile, metadata["default_runtime_profile_id"])
        if profile is not None:
            profile_metadata = dict(profile.metadata_json or {})
            profile_metadata["model"] = model_name
            profile.metadata_json = profile_metadata
            db.flush()
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


def test_direct_agent_execution_is_scoped_to_execution_tools(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db,
        _make_item(test_db, project, test_user),
        bot,
        test_user,
    )

    assert execution.runtime_origin_context["dispatch_role"] == "executor"


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


def test_stop_queued_collaboration_manager_cancels_without_changing_issue(
    test_db: Session, test_user: User
) -> None:
    from app.api.endpoints.loop_item_executions import stop_execution

    project = _make_project(test_db, test_user)
    manager = _make_bot(test_db, project, test_user)
    issue = _make_item(test_db, project, test_user)
    issue.status = "in_progress"
    execution = _make_execution(
        test_db,
        issue,
        manager,
        test_user,
        automation_context={
            "dispatch_role": "manager",
            "collaborationMode": "coordinate",
        },
    )
    background_tasks = MagicMock()

    result = stop_execution(
        project_id=int(project.id),
        execution_id=execution.id,
        background_tasks=background_tasks,
        db=test_db,
        current_user=test_user,
    )

    assert result is not None
    assert result.status == "cancelled"
    background_tasks.add_task.assert_not_called()
    test_db.refresh(issue)
    assert issue.status == "in_progress"


def test_runtime_event_matches_execution_by_any_device_identity(
    test_db: Session, test_user: User
) -> None:
    """Runtime events under the executor device name match an execution that
    persists the desktop app device id on the same Device CRD."""

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(test_db, item, bot, test_user)
    execution.runtime_device_id = "electron-app-1"
    execution.runtime_task_id = runtime_task_id_for(execution.id)
    execution.status = "claimed"
    test_db.commit()

    device = _ensure_device(test_db, test_user, "local-executor", device_type="local")
    spec = dict(device.json["spec"])
    spec["deviceId"] = "local-executor"
    spec["appDeviceId"] = "electron-app-1"
    device.json = {"spec": spec}
    test_db.commit()

    running = loop_item_execution_service.handle_runtime_event(
        db=test_db,
        device_id="local-executor",
        runtime_task_id=execution.runtime_task_id,
        event_name="response.created",
        payload={"eventSeq": 1, "data": {}},
        owner_user_id=test_user.id,
    )
    assert running is not None
    assert running.id == execution.id
    assert running.status == "running"


def test_claim_is_atomic_without_backend_robot_capacity_gating(
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
    )
    assert claimed is not None
    assert claimed.id == first.id
    assert claimed.status == "claimed"
    assert claimed.lease_expires_at is not None

    # Executor capacity is authoritative; Backend only atomically claims FIFO.
    second_claim = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert second_claim is not None
    assert second_claim.id == second.id
    test_db.refresh(second)
    assert second.status == "claimed"


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
    )
    assert claimed is not None
    assert claimed.id == urgent.id


def test_claim_next_for_device_accepts_app_registration_id(
    test_db: Session, test_user: User
) -> None:
    """A run queued under the canonical logical device id is claimable when the
    caller submits the desktop App registration id instead of that canonical id.

    The local App puller reports ``appDeviceId`` (for example
    ``electron-app-1``) while queue rows persist the canonical logical device
    id (``local-device``). Claim matching must canonicalize the submitted id
    exactly as enqueue does, otherwise the run is never claimed.
    """

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db,
        _make_item(test_db, project, test_user),
        bot,
        test_user,
    )
    # Persist the canonical logical id, as _enqueue does for an App target.
    execution.execution_device_id = "local-device"
    execution.execution_environment = "local"
    execution.status = "queued"
    test_db.commit()

    device = _ensure_device(test_db, test_user, "local-device", device_type="app")
    spec = dict(device.json["spec"])
    spec["deviceId"] = "local-device"
    spec["appDeviceId"] = "electron-app-1"
    device.json = {"spec": spec}
    test_db.commit()

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="electron-app-1",
        environment="local",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert claimed is not None
    assert claimed.id == execution.id
    # Matching uses the canonical logical id, but the runtime device is the
    # executor's own reported id so the App can route the run on it.
    assert claimed.runtime_device_id == "electron-app-1"


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


def test_trusted_terminal_snapshot_completes_without_event_sequence(
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
    )
    assert claimed is not None

    rejected = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="runtime.task.completed",
        payload={"status": "done", "data": {"value": "finished"}},
    )

    assert rejected is None
    test_db.refresh(execution)
    assert execution.status == "claimed"

    completed = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
        event_name="runtime.task.completed",
        payload={"status": "done", "data": {"value": "finished"}},
        allow_unsequenced_terminal=True,
    )

    assert completed is not None
    assert completed.status == "completed"
    assert completed.last_event_seq == 0


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


def test_manager_cancel_ack_closes_active_native_subagent_activity(
    test_db: Session, test_user: User
) -> None:
    from app.api.endpoints.loop_item_executions import stop_execution
    from app.tasks.robot_queue_tasks import emit_runtime_cancels

    execution, _, manager_activity = _make_running_automation_execution(
        test_db, test_user
    )
    issue = test_db.get(LoopItem, execution.loop_item_id)
    assert issue is not None
    issue.status = "in_progress"
    child_activity = ProjectChatMessage(
        message_id=str(uuid.uuid4()),
        project_id=manager_activity.project_id,
        task_id=manager_activity.task_id,
        sender_type="agent",
        sender_id=f"{manager_activity.agent_id}:worker-1",
        sender_name="Manager.Worker",
        message_type="text",
        content="正在执行子任务",
        metadata_json={
            "kind": "task_ai_subagent",
            "parent_agent_id": manager_activity.agent_id,
            "parent_message_id": manager_activity.message_id,
            "subagent_id": "worker-1",
            "subagent_name": "Worker",
            "subagent_status": "running",
        },
        trigger_message_id=manager_activity.message_id,
        reply_to_message_id=manager_activity.message_id,
        thread_root_message_id=manager_activity.message_id,
        agent_id=manager_activity.agent_id,
        runtime_device_id=manager_activity.runtime_device_id,
        runtime_task_id=manager_activity.runtime_task_id,
        status="streaming",
    )
    test_db.add(child_activity)
    test_db.commit()

    background_tasks = MagicMock()
    result = stop_execution(
        project_id=int(execution.cloud_project_id),
        execution_id=execution.id,
        background_tasks=background_tasks,
        db=test_db,
        current_user=test_user,
    )
    assert result is not None
    assert result.status == "cancel_requested"
    background_tasks.add_task.assert_called_once()
    task = background_tasks.add_task.call_args
    assert task.args[0] is emit_runtime_cancels
    assert [row.id for row in task.args[1]] == [execution.id]

    confirmed = loop_item_execution_service.confirm_runtime_cancelled(
        test_db,
        execution_id=execution.id,
        note="Runtime confirmed manager and child agents stopped",
    )

    assert confirmed is not None
    assert confirmed.status == "cancelled"
    test_db.refresh(manager_activity)
    test_db.refresh(child_activity)
    test_db.refresh(issue)
    assert manager_activity.status == "cancelled"
    assert child_activity.status == "cancelled"
    assert child_activity.metadata_json["subagent_status"] == "cancelled"
    assert issue.status == "in_progress"


def test_runtime_retry_uses_a_new_execution_attempt(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    run_owner = User(
        user_name="runtime-retry-owner",
        password_hash="unused",
        email="runtime-retry-owner@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(run_owner)
    test_db.commit()
    test_db.refresh(run_owner)
    original = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    original.executor_owner_user_id = run_owner.id
    original.execution_payload = (
        loop_item_execution_service._serialize_execution_intent(
            runtime_selection={
                "model": "public-model",
                "model_type": "public",
                "model_options": {"reasoningEffort": "high"},
            },
            origin_context={
                "runtime_source": "issue_snapshot",
                "workspace_binding": {"type": "standalone"},
            },
            runtime_request={"taskId": original.runtime_task_id},
        )
    )
    test_db.commit()
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=run_owner.id,
        runtime_instance_id="runtime-1",
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
    assert retry.executor_owner_user_id == run_owner.id
    assert retry.executor_owner_user_id != bot.created_by_user_id
    assert retry.runtime_task_id != claimed.runtime_task_id
    assert retry.runtime_selection == {
        "model": "public-model",
        "model_type": "public",
        "model_options": {"reasoningEffort": "high"},
    }
    assert retry.runtime_origin_context == {
        "runtime_source": "issue_snapshot",
        "workspace_binding": {"type": "standalone"},
    }
    assert retry.runtime_request == {}
    test_db.refresh(original)
    assert original.status == "failed"
    assert original.last_event_seq == 2


def test_claim_filters_by_execution_owner_not_agent_creator(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    run_owner = User(
        user_name="runtime-claim-owner",
        password_hash="unused",
        email="runtime-claim-owner@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(run_owner)
    test_db.commit()
    test_db.refresh(run_owner)
    _ensure_device(test_db, run_owner, "cloud-device-1")
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    execution.executor_owner_user_id = run_owner.id
    test_db.commit()

    creator_claim = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="creator-runtime",
    )
    owner_claim = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=run_owner.id,
        runtime_instance_id="owner-runtime",
    )

    assert creator_claim is None
    assert owner_claim is not None
    assert owner_claim.id == execution.id
    assert owner_claim.executor_owner_user_id == run_owner.id


def test_infrastructure_resume_preserves_execution_owner(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    run_owner = User(
        user_name="runtime-resume-owner",
        password_hash="unused",
        email="runtime-resume-owner@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(run_owner)
    test_db.commit()
    test_db.refresh(run_owner)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    execution.executor_owner_user_id = run_owner.id
    test_db.commit()

    resumed = loop_item_execution_service.fail(
        test_db,
        execution_id=execution.id,
        error="device temporarily unavailable",
        requeue_infra=True,
    )

    assert resumed is not None
    assert resumed.id == execution.id
    assert resumed.status == "queued"
    assert resumed.executor_owner_user_id == run_owner.id
    assert resumed.executor_owner_user_id != bot.created_by_user_id


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
    test_db: Session,
    test_user: User,
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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        lease_seconds=60,
    )
    assert claimed is not None
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
    re_claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        lease_seconds=60,
    )
    assert re_claimed is not None
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
        metadata_json=_automation_metadata(
            trigger_type="event",
            event_type="task.created",
            model="test-model",
            execution_environment="cloud",
            execution_device_id="cloud-device-1",
            timezone="Asia/Shanghai",
        ),
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


def _make_stalled_wegent_execution(
    db: Session, user: User
) -> tuple[LoopItemExecution, ProjectChatMessage]:
    """Create a running managed Wegent execution stuck past the stall window."""

    from app.services.loop_items.service import loop_item_service

    project = _make_project(db, user)
    item = _make_item(db, project, user)
    bot, _team = _make_wegent_bot(db, project, user)
    loop_item_service.assign(
        db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=user.id,
        values=LoopItemAssign(
            assignee_type="agent",
            assignee_id=bot.id,
            version=item.version,
        ),
    )
    execution = (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.agent_id == bot.id,
        )
        .one()
    )
    assert execution.execution_environment == "wegent"
    assert not execution.runtime_device_id
    execution.status = "running"
    execution.started_at = utcnow() - timedelta(minutes=44)
    message_id = str(uuid.uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=execution.cloud_project_id,
        task_id=execution.loop_item_id,
        sender_type="agent",
        sender_id=bot.id,
        sender_name=bot.title,
        message_type="agent_chunk",
        content="",
        metadata_json={"run_status": "running"},
        agent_id=bot.id,
        status="streaming",
    )
    db.add(activity)
    db.commit()
    return execution, activity


def test_stall_scan_recovers_wegent_run_without_runtime_identity(
    test_db: Session, test_user: User
) -> None:
    """A managed Wegent run executes in the Chat runtime and never claims a
    device, so its runtime ids stay empty forever. It must still be recovered.

    Regression: stall_scan skipped every execution without runtime ids, so a
    wegent run whose Chat stream died silently stayed "执行中" indefinitely and
    the task could not be modified.
    """

    execution, _activity = _make_stalled_wegent_execution(test_db, test_user)

    stalled = loop_item_execution_service.stall_scan(
        test_db, text_timeout_seconds=20 * 60
    )

    assert [run.id for run in stalled] == [execution.id]
    test_db.refresh(execution)
    assert execution.status == "cancel_requested"
    assert "未产生任何输出" in execution.execution_note


def test_stall_scan_keeps_wegent_run_with_agent_text(
    test_db: Session, test_user: User
) -> None:
    """The Wegent activity row is keyed by loop item plus agent, so its text
    must be found and read as progress rather than as a stall."""

    execution, activity = _make_stalled_wegent_execution(test_db, test_user)
    activity.content = "real progress text"
    test_db.commit()

    stalled = loop_item_execution_service.stall_scan(
        test_db, text_timeout_seconds=20 * 60
    )

    assert stalled == []
    test_db.refresh(execution)
    assert execution.status == "running"


def test_stall_scan_skips_runs_without_any_probeable_identity(
    test_db: Session, test_user: User
) -> None:
    """Without runtime ids and without an agent id no activity row can be
    located, so a stall cannot be proven and the run must be left alone."""

    execution, _activity = _make_stalled_wegent_execution(test_db, test_user)
    execution.agent_id = ""
    test_db.commit()

    stalled = loop_item_execution_service.stall_scan(
        test_db, text_timeout_seconds=20 * 60
    )

    assert stalled == []
    test_db.refresh(execution)
    assert execution.status == "running"


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


def test_approve_accepts_complete_issue_runtime_without_profile(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent=bot,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="medium",
        automation_context={
            "runtime_source": "issue_snapshot",
            "execution_device_id": "cloud-device-1",
            "model": "test-model",
            "model_type": "runtime",
            "model_options": {},
            "workspace_binding": {"type": "standalone"},
        },
    )
    test_db.commit()

    assert execution.status == "pending_approval"
    assert execution.runtime_selection["runtime_profile_id"] is None
    assert execution.runtime_selection["model"] == "test-model"

    approved = loop_item_execution_service.approve(
        test_db, execution_id=execution.id, user_id=test_user.id
    )

    assert approved.status == "queued"
    assert approved.execution_note == ""
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
        "plugins": [
            {
                "id": "github@openai",
                "pluginName": "github",
                "marketplaceId": "openai",
                "displayName": "GitHub",
            }
        ],
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
    )
    assert claimed is not None
    assert claimed.runtime_selection == {
        "runtime_source": "agent_default",
        "runtime_profile_id": bot.metadata_json["default_runtime_profile_id"],
        "runtime_profile_version": 1,
        "model": "test-model",
        "model_type": None,
        "model_options": {},
        "capability_mode": "manual",
        "workspace_policy": "project",
    }

    payload = loop_item_execution_service.build_runtime_payload(
        test_db, execution=claimed
    )
    assert payload is not None
    execution_request = payload.get("executionRequest")
    assert isinstance(execution_request, dict)
    assert execution_request["task_id"]
    assert execution_request["bot"][0]["id"] == bot.id
    assert "system_prompt" not in execution_request["bot"][0]
    assert execution_request["system_prompt"] == "Verify before reporting completion."
    assert "Build the landing page" not in execution_request["prompt"]
    assert "Create three subtasks for testing." not in execution_request["prompt"]
    visible_prompt = (
        f"project_id: {project.id}\n"
        f"task_id: {item.id}\n"
        f"execution_id: {claimed.id}\n\n"
        f"看板任务数据位于 cloud://projects/{project.id}/todos/{item.id}，"
        "请通过看板工具自行查看。"
    )
    assert execution_request["prompt"].endswith(visible_prompt)
    assert "projectSpaceCapability" in execution_request["prompt"]
    assert payload["message"] == visible_prompt
    assert payload["additionalContext"] == {}
    assert payload["projectPlugins"][0]["id"] == "github@openai"
    assert execution_request["project_plugin_ids"] == ["github@openai"]
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


@pytest.mark.parametrize(
    ("runtime", "shell_type"),
    [
        ("codex", "Codex"),
        ("claude_code", "ClaudeCode"),
    ],
)
def test_project_agent_runtime_and_capabilities_reach_runtime_request(
    test_db: Session,
    test_user: User,
    runtime: str,
    shell_type: str,
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "runtime": runtime,
        "system_prompt": "Use the configured project capabilities.",
        "additional_skills": [
            {"name": "project-review", "namespace": "default"},
        ],
        "mcp_servers": {
            "repo": {
                "command": "node",
                "args": ["repo-server.mjs"],
            }
        },
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user)

    config = project_robot_execution_config(test_db, bot)
    assert config.runtime == runtime
    assert config.system_prompt == "Use the configured project capabilities."
    assert config.additional_skills == [
        {"name": "project-review", "namespace": "default"}
    ]
    assert config.mcp_servers == {
        "repo": {
            "command": "node",
            "args": ["repo-server.mjs"],
        }
    }
    context = execution_context(
        config,
        runtime_subject_user_id=test_user.id,
    )

    request = WeworkExecutionProfile.for_project_robot(bot).build_runtime_request(
        test_db,
        execution_id=321,
        runtime_task_id=f"{runtime}-runtime-task",
        task=TaskContext(
            id=item.id,
            cloud_project_id=str(project.id),
            title=item.title,
            description="",
            status="in_progress",
            priority="medium",
        ),
        cloud_project_id=str(project.id),
        origin_context=context,
        execution_device_id="cloud-device-1",
    )

    assert request.runtime == runtime
    assert request.project_instructions == "Use the configured project capabilities."
    assert request.additional_skills == [
        {"name": "project-review", "namespace": "default"}
    ]
    assert request.bot == [
        {
            "id": bot.id,
            "name": "Execution Bot",
            "shell_type": shell_type,
            "mcp_servers": [
                {
                    "name": "repo",
                    "command": "node",
                    "args": ["repo-server.mjs"],
                }
            ],
        }
    ]


@pytest.mark.parametrize(
    ("shell_type", "runtime"),
    [
        ("Codex", "codex"),
        ("ClaudeCode", "claude_code"),
    ],
)
def test_team_reference_compiles_to_native_project_runtime(
    test_db: Session,
    test_user: User,
    shell_type: str,
    runtime: str,
) -> None:
    project = _make_project(test_db, test_user)
    agent, team = _make_native_team_binding(
        test_db,
        project,
        test_user,
        shell_type=shell_type,
    )
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "cloud-device-1")

    config = project_robot_execution_config(test_db, agent)

    assert agent.metadata_json == {
        "runtime": "wegent",
        "wegent_team_id": team.id,
        "execution_mode": "auto",
        "visibility": "public",
    }
    assert config.runtime == runtime
    assert config.model and config.model.startswith("native-model-")
    assert config.model_type == "user"
    assert config.model_options == {
        "weworkCloudModelNamespace": "default",
        "weworkCloudModelResourceUserId": str(test_user.id),
    }
    assert config.system_prompt == (
        "<base_prompt>\n"
        "Follow the referenced AgentSpec.\n\n"
        "Apply the project-specific responsibility.\n"
        "</base_prompt>"
    )
    assert config.additional_skills == [
        {
            "name": next(
                row.name
                for row in test_db.query(Kind).filter(Kind.kind == "Skill").all()
                if row.name.startswith("review-skill-")
            ),
            "namespace": "default",
        }
    ]
    assert config.mcp_servers == {
        "repo": {
            "command": "node",
            "args": ["repo-server.mjs"],
        }
    }

    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent=agent,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority=item.priority,
        automation_context=execution_context(
            config,
            runtime_subject_user_id=test_user.id,
        ),
    )

    assert execution.optional_team_id is None
    assert execution.execution_environment == "cloud"
    assert execution.execution_device_id == "cloud-device-1"
    assert execution.runtime_selection["model"] == config.model
    request = execution.runtime_request
    assert request["runtime"] == runtime
    assert request["deviceId"] == "cloud-device-1"
    assert request["modelId"] == config.model
    assert request["projectInstructions"] == config.system_prompt
    assert request["additionalSkills"] == config.additional_skills
    assert request["bot"] == [
        {
            "id": agent.id,
            "name": f"{shell_type} Agent",
            "shell_type": shell_type,
            "mcp_servers": [
                {
                    "name": "repo",
                    "command": "node",
                    "args": ["repo-server.mjs"],
                }
            ],
        }
    ]


def test_project_execution_environment_reaches_runtime_request(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    metadata = dict(project.metadata_json or {})
    metadata["execution_environment"] = {
        "repositories": [
            {
                "name": "Wegent",
                "url": "https://github.com/wecode-ai/Wegent.git",
                "ref": "main",
                "path": "wegent",
                "primary": True,
            },
            {
                "name": "SDK",
                "url": "https://github.com/example/sdk.git",
                "ref": "v2",
                "path": "deps/sdk",
                "primary": False,
            },
        ],
        "setup_steps": [
            {"command": "corepack enable", "working_directory": "wegent"},
            {"command": "pnpm install", "working_directory": "wegent"},
        ],
        "fingerprint": "environment-v1",
        "devices": {
            "cloud-device-1": {
                "status": "ready",
                "workspace_path": "/workspace/environments/project-1",
                "prepared_at": "2026-09-16T00:00:00+00:00",
                "error": "",
            }
        },
    }
    project.metadata_json = metadata
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    test_db.commit()

    request = WeworkExecutionProfile.for_project_robot(bot).build_runtime_request(
        test_db,
        execution_id=322,
        runtime_task_id="environment-runtime-task",
        task=TaskContext(
            id=item.id,
            cloud_project_id=str(project.id),
            title=item.title,
            description="",
            status="in_progress",
            priority="medium",
        ),
        cloud_project_id=str(project.id),
        origin_context={},
        execution_device_id="cloud-device-1",
    )
    payload = request.model_dump(by_alias=True, exclude_none=True)

    assert payload["execution"] == {
        "workspace": {
            "source": "git_worktree",
            "repositories": [
                {
                    "name": "Wegent",
                    "url": "https://github.com/wecode-ai/Wegent.git",
                    "ref": "main",
                    "path": "wegent",
                    "primary": True,
                },
                {
                    "name": "SDK",
                    "url": "https://github.com/example/sdk.git",
                    "ref": "v2",
                    "path": "deps/sdk",
                    "primary": False,
                },
            ],
        },
        "setup": {
            "steps": [
                {"command": "corepack enable", "workingDirectory": "wegent"},
                {"command": "pnpm install", "workingDirectory": "wegent"},
            ],
            "fingerprint": "environment-v1",
        },
    }
    assert payload["origin"]["executionEnvironment"] == {
        "repositories": [
            {
                "name": "Wegent",
                "url": "https://github.com/wecode-ai/Wegent.git",
                "ref": "main",
                "path": "wegent",
                "primary": True,
            },
            {
                "name": "SDK",
                "url": "https://github.com/example/sdk.git",
                "ref": "v2",
                "path": "deps/sdk",
                "primary": False,
            },
        ],
        "setup_steps": [
            {"command": "corepack enable", "workingDirectory": "wegent"},
            {"command": "pnpm install", "workingDirectory": "wegent"},
        ],
        "fingerprint": "environment-v1",
        "devices": {
            "cloud-device-1": {
                "status": "ready",
                "workspace_path": "/workspace/environments/project-1",
                "prepared_at": "2026-09-16T00:00:00+00:00",
                "error": "",
            }
        },
    }
    assert payload["workspacePath"] == "/workspace/environments/project-1"


async def test_app_prepared_environment_only_reaches_its_own_installation(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every Wework installation registers as ``local-device``, so the prepared
    worktree can only be matched by the record route queue rows persist.

    The environment state keeps one entry per device route id
    (``app-record-<id>``); a task landing on any other installation fails the
    preflight instead of silently ignoring the prepared worktree.
    """

    monkeypatch.setattr(
        execution_environment_initialization,
        "execute_configured_device_command",
        AsyncMock(
            return_value={
                "success": True,
                "exit_code": 0,
                "stdout": {"workspacePath": "/workspace/environments/app"},
            }
        ),
    )
    devices = [create_app_device(test_db, user_id=test_user.id) for _ in range(2)]
    definition = {
        "repositories": [
            {
                "name": "Wegent",
                "url": "https://github.com/wecode-ai/Wegent.git",
                "ref": "main",
                "path": "wegent",
                "primary": True,
            }
        ],
        "setup_steps": [],
    }
    entry = await execution_environment_initialization.initialize_execution_environment(
        db=test_db,
        device=devices[0],
        environment_id="project-app",
        definition=definition,
    )
    project = _make_project(test_db, test_user)
    project.metadata_json = {
        **dict(project.metadata_json or {}),
        "execution_environment": (
            execution_environment_initialization.merge_execution_environment_device_state(
                definition,
                device_key=runtime_device_route_id(devices[0]),
                device_state=entry,
            )
        ),
    }
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    test_db.commit()

    def workspace_path_for(execution_device_id: str) -> str:
        request = WeworkExecutionProfile.for_project_robot(bot).build_runtime_request(
            test_db,
            execution_id=451,
            runtime_task_id=f"app-environment-{execution_device_id}",
            task=TaskContext(
                id=item.id,
                cloud_project_id=str(project.id),
                title=item.title,
                description="",
                status="in_progress",
                priority="medium",
            ),
            cloud_project_id=str(project.id),
            origin_context={},
            execution_device_id=execution_device_id,
        )
        payload = request.model_dump(by_alias=True, exclude_none=True)
        return str(payload.get("workspacePath") or "")

    assert runtime_device_route_id(devices[0]) == f"app-record-{devices[0].id}"
    assert (
        workspace_path_for(f"app-record-{devices[0].id}")
        == "/workspace/environments/app"
    )
    for other_device_id in (
        f"app-record-{devices[1].id}",
        SHARED_APP_DEVICE_ID,
    ):
        with pytest.raises(
            WeworkExecutionProfileError,
            match="Project execution environment is not ready",
        ):
            workspace_path_for(other_device_id)


def test_claude_code_project_agent_compiles_executor_payload(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "runtime": "claude_code",
        "model": "test-model",
        "additional_skills": [{"name": "project-review"}],
        "mcp_servers": {
            "repo": {
                "command": "node",
                "args": ["repo-server.mjs"],
            }
        },
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user)
    config = project_robot_execution_config(test_db, bot)
    execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context=execution_context(
            config,
            runtime_subject_user_id=test_user.id,
        ),
    )

    payload = loop_item_execution_service.build_runtime_payload(
        test_db,
        execution=execution,
    )

    assert payload["runtime"] == "claude_code"
    execution_request = payload["executionRequest"]
    assert execution_request["bot"][0]["shell_type"] == "ClaudeCode"
    assert execution_request["bot"][0]["mcp_servers"] == [
        {
            "name": "repo",
            "command": "node",
            "args": ["repo-server.mjs"],
        }
    ]
    assert execution_request["preload_skills"] == [{"name": "project-review"}]


def test_git_worktree_policy_does_not_depend_on_robot_concurrency(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    _ensure_device(test_db, test_user, "local-device", "local")
    code_project = Project(
        user_id=test_user.id,
        name="Git code project",
        client_origin="wework",
        config={"path": "/tmp/git-code-project", "device_id": "local-device"},
        is_active=True,
    )
    test_db.add(code_project)
    test_db.commit()
    test_db.refresh(code_project)
    profile = WeworkExecutionProfile(
        owner_user_id=test_user.id,
        display_name="Builder",
        execution_prompt="",
        instruction="",
        model="test-model",
        local_project_id=code_project.id,
        max_concurrent_executions=1,
        workspace_policy="git_worktree",
    )

    request = profile.build_runtime_request(
        test_db,
        execution_id=92,
        runtime_task_id="runtime-task-worktree",
        task=TaskContext(
            id="item-worktree",
            cloud_project_id=str(project.id),
            title="Isolated task",
            description="",
            status="inbox",
            priority="medium",
        ),
        cloud_project_id=str(project.id),
        origin_context={},
        execution_device_id="local-device",
    )
    payload = request.model_dump(by_alias=True, exclude_none=True)

    assert payload["execution"] == {"workspace": {"source": "git_worktree"}}


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


def test_issue_cloud_moonshot_intent_overrides_local_robot_default_immutably(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user, title="Use issue runtime")
    _ensure_device(test_db, test_user, "local-device", "local")
    _ensure_device(test_db, test_user, "cloud-device-1", "cloud")
    local_profile = RuntimeProfile(
        user_id=test_user.id,
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
        name="Robot local default",
        title="Robot local default",
        device_id="local-device",
        metadata_json={
            "execution_environment": "local",
            "model": "gpt-5.6-sol",
            "model_type": "runtime",
            "model_options": {"collaborationMode": "default"},
            "workspace_policy": "project",
        },
    )
    test_db.add(local_profile)
    test_db.flush()
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Local-default robot",
        name="Local-default robot",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "default_runtime_profile_id": local_profile.id,
            "model": "gpt-5.6-sol",
            "model_type": "runtime",
            "model_options": {"collaborationMode": "default"},
            "visibility": "public",
        },
    )
    test_db.add(bot)
    test_db.flush()

    moonshot_options = {
        "weworkCloudModelNamespace": "default",
        "weworkCloudModelResourceUserId": "0",
        "weworkCloudModelUpstreamApiFormat": "anthropic-messages",
        "collaborationMode": "default",
        "permissionMode": "workspace-write",
    }
    runtime_capabilities = {
        "runtime_permission_mode": "plan",
        "execution": {
            "workspace": {
                "source": "local_path",
            }
        },
        "initial_goal": {
            "objective": "Finish the Issue with verified tests",
            "status": "active",
            "tokenBudget": 100_000,
        },
        "initial_supervisor": {
            "mode": "suggest",
            "instructions": "Prevent model or device drift",
            "modelSelection": {
                "modelName": "moonshot-kimi-k2.7-code-highspeed",
                "modelType": "public",
                "options": moonshot_options,
            },
            "intervalSeconds": 60,
        },
        "additional_skills": [{"name": "project-space"}],
        "attachments": [
            {
                "id": "issue-requirements",
                "original_filename": "requirements.md",
            }
        ],
        "project_plugins": [
            {
                "id": "github@openai",
                "pluginName": "github",
                "marketplaceId": "openai",
            }
        ],
        "additional_context": {
            "workflowStageInput": {
                "kind": "application",
                "value": "Implement and verify the selected Issue",
            }
        },
        "ephemeral": True,
    }
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent=bot,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id="local-device",
        priority="medium",
        automation_context={
            "runtime_source": "issue_snapshot",
            "execution_device_id": "cloud-device-1",
            "model": "moonshot-kimi-k2.7-code-highspeed",
            "model_type": "public",
            "model_options": moonshot_options,
            "workspace_binding": {"type": "standalone"},
            **runtime_capabilities,
        },
    )

    assert execution.execution_environment == "cloud"
    assert execution.execution_device_id == "cloud-device-1"
    assert execution.runtime_selection["model"] == ("moonshot-kimi-k2.7-code-highspeed")
    assert execution.runtime_selection["model_type"] == "public"
    assert execution.runtime_request["schemaVersion"] == 2
    assert execution.runtime_request["deviceId"] == "cloud-device-1"
    assert execution.runtime_request["modelId"] == ("moonshot-kimi-k2.7-code-highspeed")
    assert execution.runtime_request["modelType"] == "public"
    assert execution.runtime_request["modelOptions"] == moonshot_options
    assert execution.runtime_request["runtimePermissionMode"] == "plan"
    assert execution.runtime_request["execution"] == runtime_capabilities["execution"]
    assert (
        execution.runtime_request["initialGoal"] == runtime_capabilities["initial_goal"]
    )
    assert execution.runtime_request["initialSupervisor"] == (
        runtime_capabilities["initial_supervisor"]
    )
    assert execution.runtime_request["additionalSkills"] == (
        runtime_capabilities["additional_skills"]
    )
    assert (
        execution.runtime_request["attachments"] == runtime_capabilities["attachments"]
    )
    assert execution.runtime_request["projectPlugins"] == (
        runtime_capabilities["project_plugins"]
    )
    assert execution.runtime_request["additionalContext"] == (
        runtime_capabilities["additional_context"]
    )
    assert execution.runtime_request["ephemeral"] is True
    assert "modelConfig" not in execution.runtime_request

    local_profile.metadata_json = {
        **dict(local_profile.metadata_json or {}),
        "model": "changed-local-default",
    }
    bot.metadata_json = {
        **dict(bot.metadata_json or {}),
        "model": "changed-bot-default",
    }
    test_db.flush()

    model_config = {
        "model": "openai",
        "model_id": "moonshot-kimi-k2.7-code-highspeed",
        "api_format": "responses",
        "protocol": "openai-responses",
        "base_url": "https://gateway.example.com",
        "api_key": "dispatch-only-secret",
        "upstream_api_format": "anthropic-messages",
    }
    with patch(
        "app.services.chat.trigger.request_preparation._build_cloud_gateway_model_config",
        return_value=model_config,
    ) as compile_model:
        payload = loop_item_execution_service.build_runtime_payload(
            test_db,
            execution=execution,
        )

    compile_model.assert_called_once()
    assert payload["modelId"] == "moonshot-kimi-k2.7-code-highspeed"
    assert payload["modelType"] == "public"
    assert payload["runtimePermissionMode"] == "plan"
    assert payload["execution"] == runtime_capabilities["execution"]
    assert payload["initialGoal"] == runtime_capabilities["initial_goal"]
    assert payload["initialSupervisor"] == runtime_capabilities["initial_supervisor"]
    assert payload["attachments"] == runtime_capabilities["attachments"]
    assert payload["projectPlugins"] == runtime_capabilities["project_plugins"]
    assert payload["additionalContext"] == runtime_capabilities["additional_context"]
    assert payload["ephemeral"] is True
    assert payload["executionRequest"]["model_config"]["model_id"] == (
        "moonshot-kimi-k2.7-code-highspeed"
    )
    assert payload["executionRequest"]["runtime_permission_profile"] == ":workspace"
    assert payload["executionRequest"]["claude_permission_mode"] == "plan"
    assert (
        payload["executionRequest"]["attachments"]
        == runtime_capabilities["attachments"]
    )
    assert payload["executionRequest"]["project_plugin_ids"] == ["github@openai"]
    assert payload["executionRequest"]["ephemeral"] is True
    assert (
        "Implement and verify the selected Issue"
        in payload["executionRequest"]["prompt"]
    )
    assert "gpt-5.6-sol" not in json.dumps(payload)
    assert "dispatch-only-secret" not in execution.execution_payload


def test_open_execution_activity_is_idempotent_and_opens_exactly_one_message(
    test_db: Session, test_user: User
) -> None:
    from app.models.project_chat_message import ProjectChatMessage

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context={
            "dispatch_role": "member",
            "workflow_task_title": "Collect runtime evidence",
            "workflow_stage_id": "evidence",
            "coordination_round_id": "round-1",
        },
    )
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
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
    assert messages[0].metadata_json["dispatch_role"] == "member"
    assert (
        messages[0].metadata_json["workflow_task_title"] == "Collect runtime evidence"
    )
    assert messages[0].metadata_json["workflow_stage_id"] == "evidence"
    assert messages[0].metadata_json["coordination_round_id"] == "round-1"
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


def test_executor_payload_accepts_aliases_for_the_same_app_device(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user, title="Send message")
    execution = _make_execution(test_db, item, bot, test_user)
    device = Kind(
        kind="Device",
        name="device-runtime",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": "device-runtime",
                "appDeviceId": "electron-app-device",
            }
        },
    )
    test_db.add(device)
    test_db.flush()
    record_route = f"app-record-{device.id}"
    request = WeworkExecutionProfile.for_project_robot(bot).build_runtime_request(
        test_db,
        execution_id=execution.id,
        runtime_task_id=execution.runtime_task_id,
        task=TaskContext(
            id=item.id,
            cloud_project_id=str(project.id),
            title=item.title,
            description="",
            status="in_progress",
            priority="medium",
        ),
        cloud_project_id=str(project.id),
        origin_context={},
        execution_device_id=record_route,
    )
    execution.execution_environment = "cloud"
    execution.execution_device_id = record_route
    execution.execution_payload = (
        loop_item_execution_service._serialize_execution_intent(
            runtime_selection=dict(execution.runtime_selection),
            origin_context={},
            runtime_request=request.model_dump(by_alias=True, exclude_none=True),
        )
    )
    test_db.commit()

    compiled = MagicMock()
    compiled.payload = {"executionRequest": {}}
    compiled.target.device_id = record_route
    with patch(
        "app.services.runtime_work_service.compile_runtime_task_create",
        return_value=compiled,
    ) as compile_runtime:
        payload = loop_item_execution_service.build_executor_runtime_payload(
            test_db,
            execution=execution,
            execution_target_id="electron-app-device",
            executor_device_id=record_route,
        )

    assert payload == compiled.payload
    compiled_request = compile_runtime.call_args.kwargs["request"]
    assert compiled_request.device_id == record_route


def test_distinct_executors_claim_distinct_jobs_without_backend_capacity_coordination(
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
        _make_item(test_db, project, test_user, title="Second executor task"),
        second_bot,
        test_user,
    )

    first_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        runtime_device_id="runner-device-a",
        environment="cloud",
        runtime_instance_id="runner-a",
        owner_user_id=test_user.id,
    )
    second_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        runtime_device_id="runner-device-b",
        environment="cloud",
        runtime_instance_id="runner-b",
        owner_user_id=test_user.id,
    )

    assert first_claim is not None and first_claim.id == first.id
    assert second_claim is not None and second_claim.id == second.id
    assert first_claim.runtime_device_id == "runner-device-a"
    assert second_claim.runtime_device_id == "runner-device-b"


def test_same_agent_can_be_claimed_by_multiple_executor_slots(
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

    first_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        runtime_device_id="runner-device-a",
        environment="cloud",
        runtime_instance_id="runner-a",
        owner_user_id=test_user.id,
    )
    second_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        runtime_device_id="runner-device-b",
        environment="cloud",
        runtime_instance_id="runner-b",
        owner_user_id=test_user.id,
    )

    assert first_claim is not None and first_claim.id == first.id
    assert second_claim is not None and second_claim.id == second.id
    test_db.refresh(second)
    assert second.status == "claimed"


def test_agent_configured_parallelism_allows_distinct_executor_pulls(
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
        for index in range(2)
    ]

    claims = [
        loop_item_execution_service.claim_next_for_device(
            test_db,
            execution_device_id="cloud-device-1",
            runtime_device_id=f"runner-device-{index}",
            environment="cloud",
            runtime_instance_id=f"runner-{index}",
            owner_user_id=test_user.id,
        )
        for index in range(2)
    ]

    assert [claim.id for claim in claims if claim is not None] == [
        execution.id for execution in executions
    ]


def test_single_claim_uses_priority_fifo_without_backend_agent_fairness(
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
    first_executions = [
        _make_execution(
            test_db,
            _make_item(test_db, project, test_user, title=f"First {index}"),
            first_bot,
            test_user,
        )
        for index in range(3)
    ]
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
        owner_user_id=test_user.id,
    )
    second_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        runtime_instance_id="runtime-1",
        owner_user_id=test_user.id,
    )

    assert first_claim is not None and first_claim.agent_id == first_bot.id
    assert second_claim is not None and second_claim.id == first_executions[1].id
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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert claimed is not None
    # second is still queued; recording Start delivery must not touch it or
    # claim the Runtime has begun executing.
    advanced = loop_item_execution_service.mark_start_requested(
        test_db,
        execution_ids=[claimed.id, second.id],
    )
    assert advanced == 1
    test_db.refresh(claimed)
    test_db.refresh(second)
    assert claimed.status == "claimed"
    assert not loop_datetime_value_is_unset(claimed.start_requested_at)
    assert second.status == "queued"


def test_mark_start_requested_binds_issue_runtime_task_without_workflow_stage(
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
    assert binding.task_title == item.title
    assert binding.workflow_node_id is None
    assert binding.metadata_json["workspace_device_id"] == "cloud-device-1"
    assert binding.model_selection == {
        "modelName": "test-model",
        "modelType": None,
        "options": {},
    }


def test_runtime_start_fence_requires_exact_claim_identity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )

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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )

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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
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


def test_runtime_reconciliation_prefers_failure_over_stale_completed_turn(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    loop_item_execution_service.request_runtime_start(
        test_db,
        execution_id=claimed.id,
        runtime_device_id=claimed.runtime_device_id,
        runtime_task_id=claimed.runtime_task_id,
    )

    with patch(
        "app.services.project_chat.push.push_project_chat_message"
    ) as push_message:
        retry = loop_item_execution_service.reconcile_runtime_snapshot(
            test_db,
            execution_id=claimed.id,
            runtime_status="failed",
            running=False,
            turn_status="completed",
        )

    assert retry is not None
    assert retry.id != claimed.id
    assert retry.status == "queued"
    assert retry.previous_execution_id == claimed.id
    failed = test_db.get(LoopItemExecution, claimed.id)
    assert failed is not None
    assert failed.status == "failed"
    assert failed.observed_state == "failed"
    assert failed.termination_reason == "runtime_reconciled_failed"
    push_message.assert_called_once()


def test_runtime_reconciliation_restores_missing_running_activity(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
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
    assert execution_display_state(reconciled) == "starting"
    assert loop_datetime_value_is_unset(reconciled.started_at)


def test_missing_runtime_task_after_start_timeout_requeues_same_execution(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
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
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
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


def test_cancel_requested_run_does_not_gate_backend_claims(
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
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert claimed is not None
    assert claimed.id == queued.id

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


def test_claimed_lease_expiry_requeues_run(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    execution = _make_execution(
        test_db, _make_item(test_db, project, test_user), bot, test_user
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
        lease_seconds=60,
    )
    assert claimed is not None
    expired = claimed.lease_expires_at - timedelta(seconds=120)
    claimed.lease_expires_at = expired
    test_db.commit()

    requeued, failed = loop_item_execution_service.recovery_scan(
        test_db,
        now=expired + timedelta(seconds=120),
        lease_seconds=60,
    )
    assert (requeued, failed) == (1, 0)
    test_db.refresh(claimed)
    assert claimed.status == "queued"


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
        "app.services.chat.trigger.request_preparation.build_wework_runtime_model_config",
        side_effect=AssertionError("model credentials must not resolve at enqueue"),
    ):
        execution = _make_execution(test_db, item, bot, test_user)
    assert execution.runtime_selection["runtime_profile_id"]
    assert "api_key" not in execution.execution_payload
    claimed = loop_item_execution_service.claim(
        test_db,
        agent_id=bot.id,
        execution_device_id="cloud-device-1",
        environment="cloud",
        owner_user_id=test_user.id,
        runtime_instance_id="runtime-1",
    )
    assert claimed is not None
    with patch(
        "app.services.chat.trigger.request_preparation.build_wework_runtime_model_config",
        return_value=full_config,
    ) as resolve_model:
        payload = loop_item_execution_service.build_runtime_payload(
            test_db, execution=claimed
        )
    resolve_model.assert_called_once()
    model_config = payload["executionRequest"]["model_config"]
    assert model_config == full_config
    assert payload["executionRequest"]["enable_deep_thinking"] is False
    assert payload["modelId"] == "wecode-moonshot-kimi-k2.7-code-highspeed(公网)"
    assert model_config["base_url"] == "https://gateway.example.com"
    assert model_config["model_id"] == "moonshot-kimi-k2.7-code-highspeed"
    assert model_config["upstream_api_format"] == "anthropic-messages"

    rotated_config = {**full_config, "api_key": "sk-rotated-at-dispatch"}
    with patch(
        "app.services.chat.trigger.request_preparation.build_wework_runtime_model_config",
        return_value=rotated_config,
    ):
        rebuilt = loop_item_execution_service.build_runtime_payload(
            test_db, execution=claimed
        )
    assert rebuilt["executionRequest"]["model_config"]["api_key"] == (
        "sk-rotated-at-dispatch"
    )
    assert claimed.runtime_selection["runtime_profile_id"]
    assert "api_key" not in claimed.execution_payload


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
    assert model_config["tool_profile"] == "function"
    assert payload["modelId"] == "public-cloud-model"
    assert payload["executionRequest"]["enable_deep_thinking"] is False


def test_unbound_project_robot_is_claimed_by_project_authorized_device(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    device = _ensure_device(test_db, test_user, "local-device", device_type="local")
    _authorize_project_device(test_db, project, device, test_user)
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Unbound Local Bot",
        name="Unbound Local Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
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

    assert execution.status == "queued"
    assert execution.execution_device_id == ""

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="local-device",
        environment="local",
        runtime_instance_id="runtime-1",
    )

    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.status == "claimed"
    assert claimed.execution_device_id == "local-device"
    assert claimed.runtime_device_id == "local-device"


def test_follow_device_project_robot_uses_device_runtime_without_saved_model(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    device = _ensure_device(test_db, test_user, "follow-device", device_type="local")
    _authorize_project_device(test_db, project, device, test_user)
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Current device Agent",
        name="Current device Agent",
        status="active",
        created_by_user_id=test_user.id,
        device_id="",
        metadata_json={
            "runtime": "codex",
            "capability_mode": "follow_device",
            "model": None,
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    test_db.add(bot)
    test_db.commit()
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

    assert execution.status == "queued"
    assert execution.runtime_selection["model"] is None
    assert execution.runtime_selection["capability_mode"] == "follow_device"

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="follow-device",
        environment="local",
        runtime_instance_id="runtime-follow-device",
    )

    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.execution_device_id == "follow-device"


def test_unbound_project_robot_allows_owned_device_when_project_has_no_allowlist(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    _ensure_device(test_db, test_user, "unapproved-device", device_type="local")
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Unbound Local Bot",
        name="Unbound Local Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    test_db.add(bot)
    test_db.commit()
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

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="unapproved-device",
        environment="local",
        runtime_instance_id="runtime-1",
    )

    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.execution_device_id == "unapproved-device"


def test_unbound_project_robot_enforces_explicit_project_device_allowlist(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    allowed_device = _ensure_device(
        test_db, test_user, "allowlisted-device", device_type="local"
    )
    _ensure_device(test_db, test_user, "other-owned-device", device_type="local")
    _authorize_project_device(test_db, project, allowed_device, test_user)
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Allowlisted Bot",
        name="Allowlisted Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    test_db.add(bot)
    test_db.commit()
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

    rejected = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="other-owned-device",
        environment="local",
        runtime_instance_id="runtime-other",
    )
    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="allowlisted-device",
        environment="local",
        runtime_instance_id="runtime-allowed",
    )

    assert rejected is None
    assert claimed is not None
    assert claimed.id == execution.id
    assert claimed.execution_device_id == "allowlisted-device"


def test_unbound_execution_keeps_issue_on_latest_runtime_device(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    first_device = _ensure_device(
        test_db, test_user, "issue-device-a", device_type="local"
    )
    second_device = _ensure_device(
        test_db, test_user, "issue-device-b", device_type="local"
    )
    _authorize_project_device(test_db, project, first_device, test_user)
    _authorize_project_device(test_db, project, second_device, test_user)
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Affinity Bot",
        name="Affinity Bot",
        status="active",
        created_by_user_id=test_user.id,
        device_id="",
        metadata_json={
            "runtime": "codex",
            "model": "test-model",
            "execution_mode": "auto",
            "visibility": "public",
        },
    )
    test_db.add(bot)
    test_db.commit()
    item = _make_item(test_db, project, test_user)
    previous = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        executor_owner_user_id=test_user.id,
        agent_id=bot.id,
        execution_environment="local",
        execution_device_id="issue-device-a",
        runtime_device_id="issue-device-a",
        status="completed",
    )
    test_db.add(previous)
    test_db.commit()
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent=bot,
        assigner_user_id=test_user.id,
        environment="local",
        execution_device_id="",
        priority="medium",
    )
    test_db.commit()

    wrong_device_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="issue-device-b",
        environment="local",
        runtime_instance_id="runtime-b",
    )
    right_device_claim = loop_item_execution_service.claim_next_for_device(
        test_db,
        owner_user_id=test_user.id,
        execution_device_id="issue-device-a",
        environment="local",
        runtime_instance_id="runtime-a",
    )

    assert wrong_device_claim is None
    assert right_device_claim is not None
    assert right_device_claim.id == execution.id
    assert right_device_claim.execution_device_id == "issue-device-a"
    assert right_device_claim.runtime_device_id == "issue-device-a"


def test_waiting_runtime_rejects_plugin_credentials_before_creating_execution(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    bot.device_id = ""
    bot.metadata_json = {
        "runtime": "codex",
        "execution_mode": "auto",
        "visibility": "public",
    }
    test_db.commit()
    item = _make_item(test_db, project, test_user)

    with pytest.raises(ValueError, match="use credential_refs"):
        loop_item_execution_service.create_for_assignment(
            test_db,
            loop_item_id=item.id,
            cloud_project_id=item.cloud_project_id,
            agent=bot,
            assigner_user_id=test_user.id,
            environment="local",
            execution_device_id="",
            priority="medium",
            automation_context={
                "project_plugins": [
                    {
                        "id": "github@openai",
                        "config": {"access_token": "plaintext"},
                    }
                ]
            },
        )

    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .count()
        == 0
    )


@pytest.mark.parametrize(
    ("payload_field", "plugins"),
    [
        (
            "origin_context",
            [{"id": "github@openai", "config": {"access_token": "plaintext"}}],
        ),
        (
            "runtime_request",
            [{"id": "github@openai", "config": {"privateKey": "plaintext"}}],
        ),
    ],
)
def test_execution_intent_rejects_plugin_credentials_before_persistence(
    payload_field: str,
    plugins: list[dict[str, object]],
) -> None:
    kwargs: dict[str, object] = {
        "runtime_selection": {},
        "origin_context": {},
    }
    if payload_field == "origin_context":
        kwargs["origin_context"] = {"project_plugins": plugins}
    else:
        kwargs["runtime_request"] = {"projectPlugins": plugins}

    with pytest.raises(ValueError, match="use credential_refs"):
        loop_item_execution_service._serialize_execution_intent(**kwargs)


def test_automation_assignment_leaves_wegent_runtime_for_executor_pull(
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
        metadata_json=_automation_metadata(agent_id=bot.id),
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
    assert execution.backend_task_id == 0


@pytest.mark.parametrize("mode", ["auto", "manual_approval"])
def test_waiting_execution_can_select_owned_runtime_once(
    test_db: Session, test_user: User, mode: str
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    bot = _make_bot(test_db, project, test_user, mode=mode)
    _ensure_device(test_db, test_user, "cloud-device-1")
    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent=bot,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="medium",
    )
    assert execution.status == "waiting_runtime"
    initial_version = execution.version

    profile = runtime_profile_service.create(
        test_db,
        test_user.id,
        RuntimeProfileCreate(
            name="Selectable Runtime",
            execution_environment="cloud",
            execution_device_id="cloud-device-1",
            model="test-model",
            workspace_policy="project",
        ),
    )
    selected = runtime_profile_service.select_execution(
        test_db,
        execution_id=execution.id,
        user_id=test_user.id,
        profile_id=profile["id"],
        version=initial_version,
    )

    assert selected.status == (
        "pending_approval" if mode == "manual_approval" else "queued"
    )
    assert selected.runtime_selection == {
        "runtime_source": "selected",
        "runtime_profile_id": profile["id"],
        "runtime_profile_version": 1,
        "model": "test-model",
        "model_type": None,
        "model_options": {},
        "capability_mode": "manual",
        "workspace_policy": "project",
    }
    assert "execution_device_id" not in selected.runtime_selection
    with pytest.raises(HTTPException) as conflict:
        runtime_profile_service.select_execution(
            test_db,
            execution_id=execution.id,
            user_id=test_user.id,
            profile_id=profile["id"],
            version=initial_version,
        )
    assert conflict.value.status_code == 409


def test_runtime_profile_rejects_incomplete_cloud_model_identity(
    test_db: Session, test_user: User
) -> None:
    _ensure_device(test_db, test_user, "cloud-device-1")

    with pytest.raises(HTTPException) as exc_info:
        runtime_profile_service.create(
            test_db,
            test_user.id,
            RuntimeProfileCreate(
                name="Incomplete cloud Runtime",
                execution_environment="cloud",
                execution_device_id="cloud-device-1",
                model="moonshot-model",
                model_type="public",
                model_options={},
                workspace_policy="project",
            ),
        )

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail == "Cloud model identity is incomplete"


def test_runtime_profile_preserves_complete_cloud_model_identity(
    test_db: Session, test_user: User
) -> None:
    _ensure_device(test_db, test_user, "cloud-device-1")
    model_options = {
        "weworkCloudModelNamespace": "default",
        "weworkCloudModelResourceUserId": "0",
        "weworkCloudModelUpstreamApiFormat": "openai-responses",
    }

    profile = runtime_profile_service.create(
        test_db,
        test_user.id,
        RuntimeProfileCreate(
            name="Moonshot cloud Runtime",
            execution_environment="cloud",
            execution_device_id="cloud-device-1",
            model="moonshot-model",
            model_type="public",
            model_options=model_options,
            workspace_policy="project",
        ),
    )

    assert profile["model_type"] == "public"
    assert profile["model_options"] == model_options


def test_runtime_catalog_excludes_internal_migration_profiles(
    test_db: Session, test_user: User
) -> None:
    visible = RuntimeProfile(
        user_id=test_user.id,
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
        name="My Runtime",
        title="My Runtime",
        device_id="device-visible",
        metadata_json={
            "execution_environment": "local",
            "model": "visible-model",
            "model_options": {},
            "workspace_policy": "project",
        },
    )
    internal = RuntimeProfile(
        user_id=test_user.id,
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
        name="Legacy Robot Runtime",
        title="Legacy Robot Runtime",
        device_id="device-internal",
        metadata_json={
            "execution_environment": "local",
            "model": "internal-model",
            "model_options": {},
            "workspace_policy": "project",
            "catalog_visibility": "internal",
            "migrated_from": {
                "resource_type": "chat_agent",
                "resource_id": "legacy-agent",
            },
        },
    )
    test_db.add_all([visible, internal])
    test_db.commit()

    profiles = runtime_profile_service.list(test_db, test_user.id)

    assert [profile["name"] for profile in profiles] == ["My Runtime"]
    assert (
        runtime_profile_service.require_owned(test_db, str(internal.id), test_user.id)
        is internal
    )


def test_runtime_catalog_creates_one_default_per_device(
    test_db: Session, test_user: User
) -> None:
    test_db.add(
        RuntimeProfile(
            user_id=test_user.id,
            created_by_user_id=test_user.id,
            updated_by_user_id=test_user.id,
            name="内部迁移配置",
            title="内部迁移配置",
            device_id="device-local",
            metadata_json={
                "execution_environment": "local",
                "model": "legacy-model",
                "catalog_visibility": "internal",
            },
        )
    )
    test_db.commit()
    devices = [
        {
            "device_id": "device-local",
            "name": "我的本地",
            "device_type": "local",
        },
        {
            "device_id": "device-cloud",
            "name": "云端设备",
            "device_type": "cloud",
        },
    ]

    runtime_profile_service.ensure_device_defaults(test_db, test_user.id, devices)
    runtime_profile_service.ensure_device_defaults(test_db, test_user.id, devices)

    profiles = runtime_profile_service.list(test_db, test_user.id)
    assert {profile["execution_device_id"] for profile in profiles} == {
        "device-local",
        "device-cloud",
    }
    assert len(profiles) == 2
    assert all(profile["model"] == "" for profile in profiles)
    assert {
        profile["execution_device_id"]: profile["execution_environment"]
        for profile in profiles
    } == {
        "device-local": "local",
        "device-cloud": "cloud",
    }


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


def test_enqueue_generic_robot_normalizes_app_device_id(
    test_db: Session, test_user: User
) -> None:
    """Workflow robot queue rows persist the canonical logical device id."""

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    device = _ensure_device(test_db, test_user, "local-device", device_type="app")
    spec = dict(device.json["spec"])
    spec["deviceId"] = "local-device"
    spec["appDeviceId"] = "electron-app-1"
    device.json = {"spec": spec}
    test_db.commit()

    rule = ProjectAutomationRule(
        id="generic-device-rule",
        cloud_project_id=project.id,
        title="Generic device rule",
        description="Handle this task",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json=_automation_metadata(),
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger": "workflow",
            "workflow_node_id": "node-1",
            "instruction_override": "Handle this task",
        },
    )
    test_db.add_all([rule, run])
    test_db.flush()

    execution = loop_item_execution_service.enqueue_generic_robot(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        runtime_subject_user_id=test_user.id,
        runtime_profile=None,
        execution_device_id="electron-app-1",
        model="test-model",
        model_type="runtime",
        model_options={},
        assigner_user_id=test_user.id,
        priority="medium",
        automation_context={"runtime_source": "runtime_user", "run_id": str(run.id)},
    )

    assert execution.execution_device_id == f"app-record-{device.id}"
    assert execution.execution_environment == "local"


def test_enqueue_generic_robot_uses_codex_runtime_default_model(
    test_db: Session, test_user: User
) -> None:
    """A workflow robot may defer model selection to the Codex Runtime."""

    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    _ensure_device(test_db, test_user, "local-device", device_type="app")
    rule = ProjectAutomationRule(
        id="generic-default-model-rule",
        cloud_project_id=project.id,
        title="Generic default model rule",
        description="Handle this task",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json=_automation_metadata(),
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger": "workflow",
            "workflow_node_id": "node-1",
            "instruction_override": "Handle this task",
        },
    )
    test_db.add_all([rule, run])
    test_db.flush()

    execution = loop_item_execution_service.enqueue_generic_robot(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        runtime_subject_user_id=test_user.id,
        runtime_profile=None,
        execution_device_id="local-device",
        model=None,
        model_type=None,
        model_options={},
        assigner_user_id=test_user.id,
        priority="medium",
        automation_context={
            "runtime_source": "runtime_user",
            "run_id": str(run.id),
            "workspace_binding": {"type": "standalone"},
        },
    )

    assert execution.status == "queued"
    assert execution.runtime_selection["model"] is None
    profile, _ = loop_item_execution_service._runtime_profile_and_context(
        test_db,
        execution=execution,
    )
    assert profile.model == ""


def _set_app_device_id(db: Session, device: Kind, app_device_id: str) -> None:
    spec = dict(device.json["spec"])
    spec["deviceId"] = device.name
    spec["appDeviceId"] = app_device_id
    device.json = {"spec": spec}
    db.commit()


def _generic_rule_and_run(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    user: User,
    rule_id: str,
) -> ProjectAutomationRun:
    rule = ProjectAutomationRule(
        id=rule_id,
        cloud_project_id=project.id,
        title="Generic device rule",
        description="Handle this task",
        status="enabled",
        created_by_user_id=user.id,
        metadata_json=_automation_metadata(),
    )
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        status="queued",
        created_by_user_id=user.id,
        metadata_json={
            "trigger": "workflow",
            "workflow_node_id": "node-1",
            "instruction_override": "Handle this task",
        },
    )
    db.add_all([rule, run])
    db.flush()
    return run


def _enqueue_generic_run(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    user: User,
    run: ProjectAutomationRun,
) -> LoopItemExecution:
    return loop_item_execution_service.enqueue_generic_robot(
        db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        runtime_subject_user_id=user.id,
        runtime_profile=None,
        execution_device_id="electron-app-1",
        model="test-model",
        model_type="runtime",
        model_options={},
        assigner_user_id=user.id,
        priority="medium",
        automation_context={"runtime_source": "runtime_user", "run_id": str(run.id)},
    )


def test_enqueue_notifies_the_task_assignee_that_the_run_started(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(async_utils, "schedule_async_task", MagicMock())
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    assignee = User(
        user_name="runowner",
        password_hash="unused",
        email="runowner@example.com",
        is_active=True,
    )
    test_db.add(assignee)
    test_db.flush()
    item.assignee_user_id = assignee.id
    test_db.commit()
    device = _ensure_device(test_db, test_user, "local-device", device_type="app")
    _set_app_device_id(test_db, device, "electron-app-1")
    run = _generic_rule_and_run(
        test_db,
        project=project,
        item=item,
        user=test_user,
        rule_id="notify-assignee-rule",
    )

    _enqueue_generic_run(
        test_db,
        project=project,
        item=item,
        user=test_user,
        run=run,
    )

    test_db.commit()
    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.user_id == assignee.id)
        .one()
    )
    assert notification.kind == "execution"
    assert notification.url == f"wework://boards/{project.id}/issues/{item.id}"
    assert notification.payload["status"] == "queued"
    assert notification.payload["itemTitle"] == item.title


def test_enqueue_notifies_the_task_creator_when_unassigned(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(async_utils, "schedule_async_task", MagicMock())
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    device = _ensure_device(test_db, test_user, "local-device", device_type="app")
    _set_app_device_id(test_db, device, "electron-app-1")
    run = _generic_rule_and_run(
        test_db,
        project=project,
        item=item,
        user=test_user,
        rule_id="notify-creator-rule",
    )

    _enqueue_generic_run(
        test_db,
        project=project,
        item=item,
        user=test_user,
        run=run,
    )

    test_db.commit()
    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.user_id == test_user.id)
        .one()
    )
    assert notification.kind == "execution"
    assert notification.payload["itemId"] == item.id


def test_enqueue_notifies_the_runtime_wait_when_approval_also_waits(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run that both needs approval and waits for a runtime reports the row."""

    monkeypatch.setattr(async_utils, "schedule_async_task", MagicMock())
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    _ensure_device(test_db, test_user, "cloud-device-1")

    execution = loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        agent=bot,
        assigner_user_id=test_user.id,
        environment="cloud",
        execution_device_id="cloud-device-1",
        priority="medium",
    )

    test_db.commit()
    assert execution.status == "waiting_runtime"
    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.user_id == test_user.id)
        .one()
    )
    assert notification.kind == "execution"
    assert notification.payload["status"] == "waiting_runtime"
    assert "需要选择运行设备" in notification.title


def _execution_notification_ids(db: Session, user_id: int) -> list[str]:
    return [
        row.id
        for row in db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == user_id,
            WeworkNotification.kind == "execution",
        )
        .order_by(WeworkNotification.created_at)
        .all()
    ]


def test_managed_team_run_announces_its_start_once(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pipeline accepting a queued team run is not a second start notice."""

    monkeypatch.setattr(async_utils, "schedule_async_task", MagicMock())
    monkeypatch.setattr(
        type(loop_item_execution_service),
        "_push_activity",
        lambda *args, **kwargs: None,
    )
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.assignee_user_id = test_user.id
    team = Kind(
        kind="Team",
        name="board-team",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(team)
    test_db.commit()

    execution = loop_item_execution_service.create_for_team_assignment(
        test_db,
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        team=team,
        assigner_user_id=test_user.id,
        priority="medium",
    )
    test_db.commit()
    queued = _execution_notification_ids(test_db, test_user.id)
    assert len(queued) == 1
    assert test_db.get(WeworkNotification, queued[0]).payload["status"] == "queued"

    loop_item_execution_service.mark_managed_running(
        test_db, execution_id=execution.id, backend_task_id=61
    )

    assert _execution_notification_ids(test_db, test_user.id) == queued
