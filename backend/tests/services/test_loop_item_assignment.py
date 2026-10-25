# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for task assignment, robot approval, and queue state."""

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.project_chat import LoopItemApproval, LoopItemAssign
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from tests.utils.agent_resources import create_runnable_wegent_team
from tests.utils.collaboration import (
    authorize_project,
    authorize_project_agent,
    authorize_resource,
)


@pytest.fixture(autouse=True)
def isolate_notification_delivery():
    with patch("app.core.async_utils.schedule_async_task"):
        yield


def _make_project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"QUEUE{uuid.uuid4().hex[:6].upper()}",
        name="Queue project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    authorize_project(db, project)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_bot(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    mode: str = "auto",
    visibility: str = "public",
    runtime: str = "codex",
    wegent_team_id: int | None = None,
    execution_environment: str = "local",
    bind_device: bool = True,
) -> ProjectChatAgent:
    device_id = f"local-{uuid.uuid4().hex[:10]}"
    db.add(
        Kind(
            kind="Device",
            name=device_id,
            namespace="default",
            user_id=user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceType": (
                        "cloud" if execution_environment == "cloud" else "local"
                    )
                }
            },
        )
    )
    bot = ProjectChatAgent(
        id=f"B{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Queue Bot",
        name="Queue Bot",
        status="active",
        created_by_user_id=user.id,
        device_id=(
            device_id if bind_device and runtime in {"codex", "claude_code"} else None
        ),
        metadata_json={
            "runtime": runtime,
            "wegent_team_id": wegent_team_id,
            "model": "test-model",
            "execution_mode": mode,
            "execution_environment": execution_environment,
            "visibility": visibility,
        },
    )
    authorize_project_agent(db, bot)
    db.add(bot)
    db.flush()
    device = (
        db.query(Kind)
        .filter_by(kind="Device", name=device_id, namespace="default", user_id=user.id)
        .one()
    )
    authorize_resource(db, project, device)
    if wegent_team_id:
        authorize_resource(db, project, db.get(Kind, wegent_team_id))
    db.commit()
    db.refresh(bot)
    return bot


def _make_item(db: Session, project: CloudProject, user: User) -> LoopItem:
    item = LoopItem(
        id=f"T{uuid.uuid4().hex[:10]}",
        cloud_project_id=project.id,
        title="Queued task",
        description="",
        status="inbox",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def test_response_marks_issue_timestamps_as_utc(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    created_at = datetime(2026, 10, 8, 12, 27, 21)
    updated_at = datetime(2026, 10, 8, 12, 34, 54)
    item.created_at = created_at
    item.updated_at = updated_at
    test_db.commit()

    values = loop_item_service.response_values(test_db, item, test_user.id)

    assert values["created_at"] == created_at.replace(tzinfo=UTC)
    assert values["updated_at"] == updated_at.replace(tzinfo=UTC)


def test_cached_execution_end_uses_message_database_timezone(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    message = ProjectChatMessage(
        message_id="timestamp-completion",
        project_id=project.public_id,
        task_id=item.id,
        sender_type="agent",
        sender_id="bot",
        sender_name="Bot",
        message_type="text",
        content="Completed",
        metadata_json={},
        status="completed",
        created_at=datetime(2026, 10, 8, 12, 27, 23),
        updated_at=datetime(2026, 10, 8, 12, 34, 54),
    )
    test_db.add(message)
    test_db.commit()

    state = loop_item_service._present_cached_ai_state(
        test_db,
        item,
        {"status": "running", "project_chat_message_id": message.message_id},
    )

    assert state["status"] == "succeeded"
    assert state["completed_at"] == "2026-10-08T12:34:54+00:00"
    assert state["updated_at"] == state["completed_at"]


def _compiled_runtime_payload(*, request, **_kwargs):
    payload = request.model_dump(by_alias=True, exclude_none=True)
    payload["executionRequest"] = {}
    return SimpleNamespace(payload=payload)


def _collaboration_group(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    group_id: str = "group-1",
    execution_environment: str = "local",
    runtime: str = "codex",
    bind_leader_device: bool = True,
) -> tuple[dict, ProjectChatAgent, ProjectChatAgent]:
    leader = _make_bot(
        db,
        project,
        user,
        runtime=runtime,
        execution_environment=execution_environment,
        bind_device=bind_leader_device,
    )
    leader.title = "Manager"
    member = _make_bot(
        db,
        project,
        user,
        runtime=runtime,
        execution_environment=execution_environment,
    )
    member.title = "Executor"
    db.commit()
    group = {
        "id": group_id,
        "name": "Delivery team",
        "description": "Coordinate delivery.",
        "instructions": "Assign verifiable tasks and review their evidence.",
        "leader": {"kind": "agent", "id": leader.id},
        "members": [
            {
                "kind": "agent",
                "id": leader.id,
                "responsibility": "Plan and review.",
            },
            {
                "kind": "agent",
                "id": member.id,
                "name": "Executor",
                "responsibility": "Execute assigned work.",
            },
            {
                "kind": "human",
                "id": str(user.id),
                "name": user.user_name,
                "responsibility": "Provide the final business evidence.",
            },
        ],
        "coordination_mode": "manager",
        "stages": [
            {
                "id": "implementation",
                "name": "Implementation",
                "description": "Produce the implementation evidence.",
            }
        ],
        "created_at": datetime.now(),
        "version": 1,
    }
    record = Kind(
        kind="CollaborationGroup",
        name=f"Delivery {group_id}",
        namespace=f"projects/{project.id}",
        user_id=user.id,
        is_active=True,
        json={
            "spec": {
                key: group[key]
                for key in (
                    "leader",
                    "members",
                    "stages",
                    "instructions",
                    "description",
                )
            }
        },
    )
    db.add(record)
    db.flush()
    group["id"] = str(record.id)
    db.add(
        ResourceMember.create(
            resource_type="CollaborationGroup",
            resource_id=record.id,
            entity_type="project",
            entity_id=str(project.id),
            role="Developer",
            status="approved",
        )
    )
    db.commit()
    return group, leader, member


def _human_led_collaboration_group(
    user: User,
    *,
    group_id: str = "human-group-1",
) -> dict[str, object]:
    return {
        "id": group_id,
        "name": "Human-led delivery team",
        "description": "Coordinate delivery.",
        "instructions": "Assign verifiable work and review the evidence.",
        "leader": {
            "kind": "human",
            "id": str(user.id),
            "name": user.user_name,
        },
        "members": [
            {
                "kind": "human",
                "id": str(user.id),
                "name": user.user_name,
            }
        ],
        "coordination_mode": "manager",
        "stages": [
            {
                "id": "implementation",
                "name": "Implementation",
                "description": "Produce the implementation evidence.",
            }
        ],
        "created_at": datetime.now(),
        "version": 1,
    }


def _active_execution(db: Session, item: LoopItem) -> LoopItemExecution | None:
    return (
        db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == item.id,
            LoopItemExecution.status.in_(["pending_approval", "queued", "running"]),
        )
        .order_by(LoopItemExecution.id.desc())
        .first()
    )


def test_collaboration_group_owner_is_project_scoped_and_persisted(
    test_db: Session, test_user: User
):
    db = test_db
    project = _make_project(db, test_user)
    item = _make_item(db, project, test_user)
    group, _leader, _member = _collaboration_group(db, project, test_user)
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        updated = loop_item_service.update(
            db,
            item.id,
            test_user.id,
            LoopItemUpdate(version=item.version, assignee_group_id=str(group["id"])),
        )
        assigned = loop_item_service.assign(
            db,
            project_id=project.id,
            item_id=updated.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=updated.version,
                assignee_type="group",
                assignee_id=str(group["id"]),
            ),
        )
    db.refresh(assigned)
    assert assigned.metadata_json["collaboration_group"]["id"] == str(group["id"])
    assert assigned.assignee_user_id is None
    values = loop_item_service.response_values(db, assigned, test_user.id)
    assert values["assignee_group_name"] == "Delivery team"
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[],
    ):
        with pytest.raises(HTTPException) as error:
            loop_item_service.update(
                db,
                item.id,
                test_user.id,
                LoopItemUpdate(
                    version=assigned.version, assignee_group_id="other-project-team"
                ),
            )
    assert error.value.status_code == 422
    restored = loop_item_service.update(
        db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=assigned.version, assignee_user_id=test_user.id),
    )
    assert not restored.metadata_json.get("collaboration_group")
    assert restored.assignee_user_id == test_user.id


def test_create_with_collaboration_group_preserves_group_as_owner(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    group, _leader, _member = _collaboration_group(test_db, project, test_user)

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        item = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Group-owned task",
                assignee_group_id=str(group["id"]),
            ),
        )

    assert item.assignee_user_id is None
    assert item.assignee_agent_id == ""
    assert item.assignee_team_id is None
    assert item.status == "in_progress"
    assert item.metadata_json["collaboration_group"] == {
        "id": str(group["id"]),
        "name": "Delivery team",
    }
    values = loop_item_service.response_values(test_db, item, test_user.id)
    assert values["assignee_group_id"] == str(group["id"])
    assert values["assignee_group_name"] == "Delivery team"


def test_create_with_human_led_group_notifies_leader_without_executor_dispatch(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    group = _human_led_collaboration_group(test_user)

    with (
        patch(
            "app.services.workspaces.workspace_service."
            "list_project_collaboration_groups",
            return_value=[group],
        ),
        patch(
            "app.services.collaboration_group_execution.create_notification"
        ) as notify,
    ):
        item = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Human-coordinated task",
                description="Coordinate this work.",
                assignee_group_id=str(group["id"]),
            ),
        )

    notify.assert_called_once()
    assert notify.call_args.kwargs["user_id"] == test_user.id
    assert notify.call_args.kwargs["item_id"] == item.id
    payload = notify.call_args.kwargs["payload"]
    assert payload["action"] == "coordinate_collaboration_group"
    assert payload["collaborationGroupAssignmentKey"].startswith(
        f"group:{group['id']}:"
    )
    assert "Assign verifiable work" in payload["instructions"]
    assert payload["projectName"] == project.name
    assert payload["itemKey"] == item.id
    assert payload["itemTitle"] == item.title
    assert payload["itemStatus"] == "进行中"
    assert payload["assigneeName"] == test_user.user_name
    assert payload.get("humanAssignmentId") is None
    assert item.status == "in_progress"
    assert _active_execution(test_db, item) is None


@pytest.mark.parametrize("runtime", ["codex", "claude_code"])
@pytest.mark.parametrize("execution_environment", ["local", "cloud"])
def test_collaboration_group_assignment_hands_one_dispatch_to_executor(
    test_db: Session,
    test_user: User,
    execution_environment: str,
    runtime: str,
) -> None:
    project = _make_project(test_db, test_user)
    project.metadata_json = {
        "workflow_definition": {
            "nodes": [
                {
                    "id": "implementation",
                    "name": "Implementation",
                    "description": "Produce evidence.",
                }
            ]
        }
    }
    item = _make_item(test_db, project, test_user)
    group, leader, member = _collaboration_group(
        test_db,
        project,
        test_user,
        execution_environment=execution_environment,
        runtime=runtime,
    )
    test_db.commit()

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        assigned = loop_item_service.assign(
            test_db,
            project_id=project.id,
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="group",
                assignee_id=str(group["id"]),
            ),
        )
        repeated = loop_item_service.assign(
            test_db,
            project_id=project.id,
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=assigned.version,
                assignee_type="group",
                assignee_id=str(group["id"]),
            ),
        )

    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .all()
    )
    assert repeated.id == item.id
    assert repeated.status == "in_progress"
    assert len(executions) == 1
    dispatch = executions[0]
    assert dispatch.status == "queued"
    assert dispatch.agent_id == ""
    assert dispatch.executor_type == "collaboration_group_dispatch"
    assert dispatch.execution_environment == execution_environment
    assert dispatch.runtime_request == {}
    dispatch_request = dispatch.execution_intent["dispatch_request"]
    assert dispatch_request == {"kind": "collaboration_group"}
    assert dispatch.runtime_origin_context["dispatch_kind"] == "collaboration_group"
    assert dispatch.runtime_origin_context["dispatch_role"] == "manager"
    assert dispatch.runtime_origin_context["dispatch_task_id"] == item.id
    assert dispatch.runtime_origin_context["collaboration_group_id"] == group["id"]
    assert dispatch.runtime_origin_context["collaboration_group"]["id"] == group["id"]
    assert dispatch.runtime_origin_context["collaboration_group"]["leader"]["id"] == (
        leader.id
    )
    assert "collaborationMode" not in dispatch.runtime_origin_context
    assert "coordinate_bots" not in dispatch.runtime_origin_context
    assert group["instructions"] in dispatch.runtime_origin_context["execution_prompt"]
    assert '"kind": "human"' in dispatch.runtime_origin_context["execution_prompt"]
    assert test_user.user_name in dispatch.runtime_origin_context["execution_prompt"]
    assert "Provide the final business evidence." in (
        dispatch.runtime_origin_context["execution_prompt"]
    )
    assert f'"id": "{leader.id}"' in (
        dispatch.runtime_origin_context["execution_prompt"]
    )
    assert "workflow_definition" not in dispatch.runtime_origin_context["system_prompt"]
    assert "Implementation" in dispatch.runtime_origin_context["execution_prompt"]
    activity_profile, activity_context = (
        loop_item_execution_service._runtime_profile_and_context(
            test_db,
            execution=dispatch,
        )
    )
    assert activity_profile.display_name == "Manager"
    assert activity_context["manager_agent_id"] == leader.id

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id=str(dispatch.execution_device_id),
        environment=execution_environment,
        runtime_instance_id=f"{execution_environment}-executor",
        owner_user_id=dispatch.executor_owner_user_id,
    )
    assert claimed is not None
    assert claimed.id == dispatch.id
    assert claimed.status == "claimed"
    with patch(
        "app.services.runtime_work_service.compile_runtime_task_create",
        side_effect=_compiled_runtime_payload,
    ):
        runtime_payload = loop_item_execution_service.build_executor_runtime_payload(
            test_db,
            execution=claimed,
            execution_target_id=str(claimed.execution_device_id),
            executor_device_id=str(claimed.execution_device_id),
        )
    assert runtime_payload["dispatchKind"] == "collaboration_group"
    manager_request = runtime_payload["managerRuntimeRequest"]
    assert manager_request["origin"]["dispatchRole"] == "manager"
    assert [value["id"] for value in manager_request["bot"]] == [leader.id]
    member_profiles = runtime_payload["memberRuntimeProfiles"]
    assert {profile["agentId"] for profile in member_profiles} == {
        leader.id,
        member.id,
    }
    member_profile = next(
        profile for profile in member_profiles if profile["agentId"] == member.id
    )
    assert str(member.id) in member_profile["memberIds"]
    assert member_profile["runtimePayload"]["origin"]["dispatchRole"] == "member"
    assert (
        member_profile["runtimePayload"]["projectInstructions"]
        != manager_request["projectInstructions"]
    )
    assert "You are the manager for one project Issue." not in (
        member_profile["runtimePayload"]["projectInstructions"]
    )
    assert "executionId" not in member_profile["runtimePayload"]["origin"]
    assert (
        manager_request["bot"][0]["shell_type"]
        == {
            "codex": "Codex",
            "claude_code": "ClaudeCode",
        }[runtime]
    )


def test_collaboration_group_execution_terminal_does_not_change_issue_status(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    group, _leader, _member = _collaboration_group(test_db, project, test_user)

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        assigned = loop_item_service.assign(
            test_db,
            project_id=project.id,
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="group",
                assignee_id=str(group["id"]),
            ),
        )

    assert assigned.status == "in_progress"
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .one()
    )
    loop_item_execution_service.complete(
        test_db,
        execution_id=execution.id,
        content="Manager finished its turn.",
    )

    test_db.refresh(item)
    assert item.status == "in_progress"


def test_unbound_collaboration_dispatch_uses_claiming_executor_device(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    group, _leader, _member = _collaboration_group(
        test_db,
        project,
        test_user,
        bind_leader_device=False,
    )
    claim_device_id = f"claim-{uuid.uuid4().hex[:10]}"
    test_db.add(
        Kind(
            kind="Device",
            name=claim_device_id,
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={"spec": {"deviceType": "local"}},
        )
    )
    test_db.flush()
    authorize_resource(
        test_db,
        project,
        test_db.query(Kind)
        .filter_by(
            kind="Device",
            name=claim_device_id,
            namespace="default",
            user_id=test_user.id,
        )
        .one(),
    )
    test_db.commit()

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        loop_item_service.assign(
            test_db,
            project_id=project.id,
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="group",
                assignee_id=str(group["id"]),
            ),
        )

    dispatch = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .one()
    )
    assert dispatch.execution_device_id == ""
    assert dispatch.execution_intent["dispatch_request"] == {
        "kind": "collaboration_group"
    }

    claimed = loop_item_execution_service.claim_next_for_device(
        test_db,
        execution_device_id=claim_device_id,
        runtime_device_id=claim_device_id,
        environment="local",
        runtime_instance_id="claiming-executor",
        owner_user_id=dispatch.executor_owner_user_id,
    )

    assert claimed is not None
    with patch(
        "app.services.runtime_work_service.compile_runtime_task_create",
        side_effect=_compiled_runtime_payload,
    ):
        payload = loop_item_execution_service.build_executor_runtime_payload(
            test_db,
            execution=claimed,
            execution_target_id=claim_device_id,
            executor_device_id=claim_device_id,
        )
    assert payload["managerRuntimeRequest"]["deviceId"] == claim_device_id


def test_collaboration_group_rejects_non_executor_runtime(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    group, leader, member = _collaboration_group(test_db, project, test_user)
    leader_team = create_runnable_wegent_team(
        test_db,
        user_id=test_user.id,
        name_prefix="group-leader",
    )
    authorize_resource(test_db, project, leader_team)
    leader.device_id = None
    leader.metadata_json = {
        **dict(leader.metadata_json or {}),
        "runtime": "wegent",
        "wegent_team_id": leader_team.id,
    }
    test_db.commit()

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        with pytest.raises(
            HTTPException,
            match="Collaboration group AI must use an Executor runtime",
        ):
            loop_item_service.assign(
                test_db,
                project_id=project.id,
                item_id=item.id,
                user_id=test_user.id,
                values=LoopItemAssign(
                    version=item.version,
                    assignee_type="group",
                    assignee_id=str(group["id"]),
                ),
            )


def _make_member(db: Session, project: CloudProject, name: str, role: BaseRole) -> User:
    user = User(
        user_name=name,
        password_hash="unused",
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.flush()
    db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=project.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    db.commit()
    db.refresh(user)
    return user


def test_assign_to_robot_enters_queue_with_history(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version, assignee_type="agent", assignee_id=bot.id
        ),
    )

    assert updated.assignee_agent_id == bot.id
    assert updated.assignee_user_id is None
    metadata = updated.metadata_json or {}
    history = metadata["assignment_history"]
    assert history[-1]["by_user_id"] == test_user.id
    assert history[-1]["to_type"] == "agent"
    assert history[-1]["to_id"] == bot.id
    execution = _active_execution(test_db, updated)
    assert execution is not None
    assert execution.status == "queued"
    assert execution.agent_id == bot.id
    assert execution.assigner_user_id == test_user.id


def test_assign_robot_from_inbox_starts_work_in_progress(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    assert item.status == "inbox"

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version, assignee_type="agent", assignee_id=bot.id
        ),
    )

    assert updated.status == "in_progress"
    history = (updated.metadata_json or {})["status_history"]
    assert history[-1]["trigger"] == "robot_assignment"
    assert history[-1]["from_status"] == "inbox"
    assert history[-1]["to_status"] == "in_progress"
    assert _active_execution(test_db, updated) is not None


def test_update_assignee_robot_starts_run_from_inbox(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)

    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, assignee_agent_id=bot.id),
    )

    assert updated.status == "in_progress"
    assert updated.assignee_agent_id == bot.id
    history = (updated.metadata_json or {})["status_history"]
    assert history[-1]["trigger"] == "robot_assignment"
    execution = _active_execution(test_db, updated)
    assert execution is not None
    assert execution.agent_id == bot.id


def test_update_assignee_robot_respects_explicit_status(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)

    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, assignee_agent_id=bot.id, status="inbox"),
    )

    assert updated.status == "inbox"
    assert _active_execution(test_db, updated) is not None


def test_update_assignee_robot_reenters_in_progress_from_review(
    test_db: Session, test_user: User
) -> None:
    """Reassigning a robot starts new work, matching the executor's board."""
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    item.status = "in_review"
    test_db.commit()

    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, assignee_agent_id=bot.id),
    )

    assert updated.status == "in_progress"
    assert _active_execution(test_db, updated) is not None


def test_create_robot_assignee_starts_in_progress(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)

    item = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title="Robot owned", assignee_agent_id=bot.id),
    )

    assert item.status == "in_progress"
    assert _active_execution(test_db, item) is not None


@pytest.mark.parametrize("target_type", ["agent", "team"])
def test_create_completed_issue_does_not_start_execution(
    test_db: Session, test_user: User, target_type: str
) -> None:
    project = _make_project(test_db, test_user)
    if target_type == "agent":
        bot = _make_bot(test_db, project, test_user)
        assignment = {"assignee_agent_id": bot.id}
    else:
        team = create_runnable_wegent_team(
            test_db, user_id=test_user.id, name_prefix="completed"
        )
        _make_bot(test_db, project, test_user, wegent_team_id=team.id)
        assignment = {"assignee_team_id": team.id}

    item = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title="Already done", status="completed", **assignment),
    )

    assert item.status == "completed"
    assert item.completed_at is not None
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .count()
        == 0
    )


def test_refresh_execution_configuration_starts_run_without_snapshot(
    test_db: Session, test_user: User
) -> None:
    """Entering processing starts a Run even without an execution_config snapshot."""
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    item.assignee_agent_id = bot.id
    item.status = "in_progress"
    test_db.commit()

    loop_item_service.refresh_agent_execution_configuration(
        test_db, item=item, user_id=test_user.id
    )

    assert _active_execution(test_db, item) is not None


def test_assign_to_wegent_runtime_robot_keeps_robot_as_queue_identity(
    test_db: Session,
    test_user: User,
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    team = create_runnable_wegent_team(
        test_db,
        user_id=test_user.id,
        name_prefix="board",
    )
    bot = _make_bot(
        test_db,
        project,
        test_user,
        runtime="wegent",
        wegent_team_id=team.id,
    )

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )

    assert updated.assignee_team_id is None
    assert updated.assignee_user_id is None
    assert updated.assignee_agent_id == bot.id
    history = (updated.metadata_json or {})["assignment_history"]
    assert history[-1]["to_type"] == "agent"
    assert history[-1]["to_id"] == bot.id
    execution = _active_execution(test_db, updated)
    assert execution is not None
    assert execution.executor_type == "project_robot"
    assert execution.team_id == team.id
    assert execution.agent_id == bot.id
    assert execution.execution_environment == "wegent"
    assert execution.status == "queued"


def test_assign_to_member_records_chain(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "assignee", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    with patch(
        "app.services.loop_items.service.loop_node_non_nullable_attributes",
        return_value=frozenset(),
    ) as nullable_contract:
        updated = loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="user",
                assignee_id=str(member.id),
            ),
        )

    nullable_contract.assert_called_once()
    assert updated.assignee_user_id == member.id
    assert updated.assignee_agent_id == ""
    assert updated.assignee_team_id is None
    metadata = updated.metadata_json or {}
    assert metadata["assignment_history"][-1]["to_type"] == "user"
    assert metadata["assignment_history"][-1]["to_name"] == "assignee"
    assert _active_execution(test_db, updated) is None


@pytest.mark.parametrize("initial_status", ["in_progress", "in_review", "completed"])
def test_assign_to_member_preserves_issue_status(
    test_db: Session,
    test_user: User,
    initial_status: str,
) -> None:
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "status-owner", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)
    item.status = initial_status
    item.completed_at = datetime(2026, 10, 1) if initial_status == "completed" else None
    test_db.commit()

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(member.id),
        ),
    )

    assert updated.status == initial_status
    if initial_status == "completed":
        assert updated.completed_at == datetime(2026, 10, 1)


def test_assign_to_other_member_sends_notification(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "assignee", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    with patch(
        "app.services.collaboration_human_assignments." "notify_direct_human_assignment"
    ) as notify:
        loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="user",
                assignee_id=str(member.id),
            ),
        )

    notify.assert_called_once()
    assert notify.call_args.kwargs["project"] == project
    assert notify.call_args.kwargs["issue"] == item
    assert notify.call_args.kwargs["human"] == member
    assert notify.call_args.kwargs["actor_user_id"] == test_user.id
    assert notify.call_args.kwargs["assignment_id"]


def test_update_assignee_notifies_the_new_owner(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    member = _make_member(test_db, project, "next-owner", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    with patch(
        "app.services.collaboration_human_assignments." "notify_direct_human_assignment"
    ) as notify:
        loop_item_service.update(
            test_db,
            item.id,
            test_user.id,
            LoopItemUpdate(version=item.version, assignee_user_id=member.id),
        )

    notify.assert_called_once()
    assert notify.call_args.kwargs["project"] == project
    assert notify.call_args.kwargs["issue"] == item
    assert notify.call_args.kwargs["human"] == member
    assert notify.call_args.kwargs["actor_user_id"] == test_user.id
    assert notify.call_args.kwargs["assignment_id"]


def test_assign_to_self_does_not_send_notification(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)

    with patch(
        "app.services.collaboration_human_assignments." "notify_direct_human_assignment"
    ) as notify:
        loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="user",
                assignee_id=str(test_user.id),
            ),
        )

    notify.assert_not_called()


def test_create_with_explicit_self_assignment_sends_dispatch_notification(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)

    with patch(
        "app.services.collaboration_human_assignments." "notify_direct_human_assignment"
    ) as notify:
        item = loop_item_service.create(
            test_db,
            int(project.id),
            test_user.id,
            LoopItemCreate(
                title="Explicit personal assignment",
                assignee_user_id=test_user.id,
                notify_assignee=True,
            ),
        )

    notify.assert_called_once()
    assert notify.call_args.kwargs["issue"] == item
    assert notify.call_args.kwargs["human"] == test_user


def test_explicit_self_assignment_can_send_dispatch_notification(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)

    with patch(
        "app.services.collaboration_human_assignments." "notify_direct_human_assignment"
    ) as notify:
        loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="user",
                assignee_id=str(test_user.id),
                notify_self=True,
            ),
        )

    notify.assert_called_once()


def test_manual_approval_flow_only_creator_can_approve(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    creator_bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    member = _make_member(test_db, project, "developer", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=creator_bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"

    with pytest.raises(HTTPException, match="Only the robot creator"):
        loop_item_service.approve_run(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=member.id,
            values=LoopItemApproval(version=assigned.version),
        )

    approved = loop_item_service.approve_run(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemApproval(version=assigned.version),
    )
    execution = _active_execution(test_db, approved)
    assert execution is not None
    assert execution.status == "queued"
    assert execution.approval_status == "approved"
    assert execution.approved_by_user_id == test_user.id


def test_reject_run_cancels_with_reason(test_db: Session, test_user: User) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)

    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    rejected = loop_item_service.reject_run(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemApproval(version=assigned.version, reason="Not now"),
    )
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == rejected.id)
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    assert execution is not None
    assert execution.status == "cancelled"
    assert execution.approval_status == "rejected"
    assert execution.rejected_reason == "Not now"


def test_approve_with_stale_version_has_no_side_effects(
    test_db: Session, test_user: User
) -> None:
    """A stale-version approve must 409 and leave the run pending.

    Regression: approve used to commit the run transition before the item
    version check, so a conflicting request half-applied the approval and
    dispatched the run even though the client saw "TODO changed".
    """

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)
    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"

    with pytest.raises(HTTPException, match="TODO changed"):
        loop_item_service.approve_run(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemApproval(version=assigned.version + 1),
        )

    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"
    assert execution.approved_by_user_id != test_user.id


def test_reject_with_stale_version_has_no_side_effects(
    test_db: Session, test_user: User
) -> None:
    """A stale-version reject must 409 and leave the run pending."""

    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user, mode="manual_approval")
    item = _make_item(test_db, project, test_user)
    assigned = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"

    with pytest.raises(HTTPException, match="TODO changed"):
        loop_item_service.reject_run(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=test_user.id,
            values=LoopItemApproval(version=assigned.version + 1),
        )

    execution = _active_execution(test_db, assigned)
    assert execution is not None
    assert execution.status == "pending_approval"
    assert execution.approval_status == "pending"


def test_assignment_requires_member_role_and_enabled_agent(
    test_db: Session, test_user: User
) -> None:
    """Only the creator or Developer+ may assign; the robot must stay visible."""

    project = _make_project(test_db, test_user)
    private_bot = _make_bot(test_db, project, test_user)
    viewer = _make_member(test_db, project, "viewer", BaseRole.Viewer)
    developer = _make_member(test_db, project, "dev", BaseRole.Developer)
    maintainer = _make_member(test_db, project, "admin", BaseRole.Maintainer)
    item = _make_item(test_db, project, test_user)

    with pytest.raises(HTTPException, match="Insufficient permission"):
        loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=viewer.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="agent",
                assignee_id=private_bot.id,
            ),
        )

    for assigner in (developer, maintainer):
        updated = loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=assigner.id,
            values=LoopItemAssign(
                version=item.version, assignee_type="agent", assignee_id=private_bot.id
            ),
        )
        assert updated.assignee_agent_id == private_bot.id


def test_developer_can_assign_issue_to_member(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    developer = _make_member(test_db, project, "dev", BaseRole.Developer)
    member = _make_member(test_db, project, "assignee", BaseRole.Developer)
    item = _make_item(test_db, project, test_user)

    updated = loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=developer.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="user",
            assignee_id=str(member.id),
        ),
    )

    assert updated.assignee_user_id == member.id
    metadata = updated.metadata_json or {}
    assert metadata["assignment_history"][-1]["by_user_id"] == developer.id


def test_viewer_creator_cannot_assign_outside_role(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    creator = _make_member(test_db, project, "creator", BaseRole.Viewer)
    item = _make_item(test_db, project, creator)

    with pytest.raises(HTTPException, match="Insufficient permission"):
        updated = loop_item_service.assign(
            test_db,
            project_id=int(project.id),
            item_id=item.id,
            user_id=creator.id,
            values=LoopItemAssign(
                version=item.version,
                assignee_type="agent",
                assignee_id=bot.id,
            ),
        )

    assert item.assignee_agent_id == ""


def test_queue_listing_is_a_projection_of_assigned_tasks(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    member = _make_member(test_db, project, "worker", BaseRole.Developer)
    queued_item = _make_item(test_db, project, test_user)
    completed_item = _make_item(test_db, project, test_user)
    completed_item.status = "completed"
    test_db.commit()

    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=queued_item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=queued_item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=completed_item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=completed_item.version,
            assignee_type="user",
            assignee_id=str(member.id),
        ),
    )

    bot_queue = loop_item_service.list(
        test_db,
        int(project.id),
        test_user.id,
        assignee_type="agent",
        assignee_id=bot.id,
        execution_state="queued",
    )
    assert [item.id for item in bot_queue] == [queued_item.id]

    member_queue = loop_item_service.list(
        test_db,
        int(project.id),
        test_user.id,
        assignee_type="user",
        assignee_id=str(member.id),
    )
    assert [item.id for item in member_queue] == [completed_item.id]
    test_db.refresh(completed_item)
    assert completed_item.status == "completed"


def test_my_work_uses_latest_execution_truth_instead_of_task_binding(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    loop_item_service.assign(
        test_db,
        project_id=int(project.id),
        item_id=item.id,
        user_id=test_user.id,
        values=LoopItemAssign(
            version=item.version,
            assignee_type="agent",
            assignee_id=bot.id,
        ),
    )
    execution = _active_execution(test_db, item)
    assert execution is not None
    execution.status = "claimed"
    execution.sync_state = "stale"
    execution.observed_state = "unconfirmed"
    execution.attempt_no = 2
    execution.last_event_seq = 17
    test_db.commit()

    row = next(
        value
        for value in loop_item_service.list_my_work(test_db, test_user.id)
        if value["id"] == item.id
    )
    assert row["execution_state"] == "unknown"
    assert row["execution_control_state"] == "claimed"
    assert row["execution_observed_state"] == "unconfirmed"
    assert row["execution_sync_state"] == "stale"
    assert row["execution_attempt_no"] == 2
    assert row["execution_last_event_seq"] == 17
    assert row["ai_state"]["status"] == "unknown"


def test_my_work_limits_results_before_loading_item_details(
    test_db: Session, test_user: User
) -> None:
    project = _make_project(test_db, test_user)
    base_time = datetime(2026, 1, 1)
    item_ids = [f"LIMIT-{index:03d}" for index in range(105)]
    test_db.add_all(
        [
            LoopItem(
                id=item_id,
                cloud_project_id=project.id,
                title=item_id,
                description="",
                status="inbox",
                created_by_user_id=test_user.id,
                metadata_json={},
                updated_at=base_time + timedelta(minutes=index),
            )
            for index, item_id in enumerate(item_ids)
        ]
    )
    test_db.commit()

    rows = loop_item_service.list_my_work(test_db, test_user.id)

    assert len(rows) == 100
    assert [row["id"] for row in rows] == list(reversed(item_ids[5:]))
    with pytest.raises(ValueError, match="limit must be between 1 and 100"):
        loop_item_service.list_my_work(test_db, test_user.id, limit=101)


def _make_external_project(db: Session, user: User) -> CloudProject:
    project = _make_project(db, user)
    project.metadata_json = {
        "task_provider": "github",
        "provider_config": {"repository": "octo/example"},
    }
    db.commit()
    db.refresh(project)
    return project


def _external_issue(*labels: str) -> dict[str, object]:
    return {
        "number": 7,
        "title": "External issue",
        "state": "open",
        "labels": list(labels),
    }


def _external_response(*, can_view_detail: bool) -> dict[str, object]:
    return {
        "can_view_detail": can_view_detail,
        "can_edit": can_view_detail,
        "tags": ["bug"],
        "status": "inbox",
        "priority": "none",
        "security_level": "open",
        "parent_id": None,
        "description": "",
        "assignee_user_id": None,
    }


def test_update_requires_content_permission_for_mixed_change(
    test_db: Session, test_user: User
) -> None:
    """A Viewer creator may only reroute the assignee, never the content."""

    project = _make_project(test_db, test_user)
    creator = _make_member(test_db, project, "creator", BaseRole.Viewer)
    item = _make_item(test_db, project, creator)
    original_title = item.title

    with pytest.raises(HTTPException) as excinfo:
        loop_item_service.update(
            test_db,
            item.id,
            creator.id,
            LoopItemUpdate(
                version=item.version,
                title="renamed",
                assignee_user_id=test_user.id,
            ),
        )

    assert excinfo.value.status_code == 403
    test_db.refresh(item)
    assert item.title == original_title

    with pytest.raises(HTTPException, match="Insufficient permission"):
        updated = loop_item_service.update(
            test_db,
            item.id,
            creator.id,
            LoopItemUpdate(version=item.version, assignee_user_id=test_user.id),
        )

    assert item.assignee_user_id is None
    test_db.refresh(item)
    assert item.title == original_title


def test_external_assign_rejects_issue_hidden_from_developer(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Assignment must respect issue visibility, not just the assign action."""

    from app.services.loop_items.external_provider import (
        external_loop_item_provider,
    )

    project = _make_external_project(test_db, test_user)
    developer = _make_member(test_db, project, "dev", BaseRole.Developer)
    issue = _external_issue("wegent:creator:9999:hidden", "wegent:security:related")
    update_issue = MagicMock()
    monkeypatch.setattr(
        external_loop_item_provider, "_get_issue", MagicMock(return_value=issue)
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_response",
        MagicMock(return_value=_external_response(can_view_detail=False)),
    )
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update_issue)

    with pytest.raises(HTTPException) as excinfo:
        external_loop_item_provider.assign(
            test_db,
            f"{project.project_key}-7",
            developer.id,
            LoopItemAssign(
                version=1,
                assignee_type="user",
                assignee_id=str(test_user.id),
            ),
        )

    assert excinfo.value.status_code == 404
    update_issue.assert_not_called()


def test_external_assign_preserves_creator_label(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Provider writes replace every label, so the creator label must survive."""

    from app.services.loop_items.external_provider import (
        external_loop_item_provider,
    )

    project = _make_external_project(test_db, test_user)
    developer = _make_member(test_db, project, "dev", BaseRole.Developer)
    assignee = _make_member(test_db, project, "assignee", BaseRole.Developer)
    issue = _external_issue("bug", "wegent:creator:1234:owner")
    update_issue = MagicMock(return_value=issue)
    monkeypatch.setattr(
        external_loop_item_provider, "_get_issue", MagicMock(return_value=issue)
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_response",
        MagicMock(return_value=_external_response(can_view_detail=True)),
    )
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update_issue)

    external_loop_item_provider.assign(
        test_db,
        f"{project.project_key}-7",
        developer.id,
        LoopItemAssign(
            version=1,
            assignee_type="user",
            assignee_id=str(assignee.id),
            notify_assignee=False,
        ),
    )

    labels = update_issue.call_args.args[2]["labels"]
    assert "wegent:creator:1234:owner" in labels
    assert f"wegent:assignee:user:{assignee.id}" in labels


def test_external_update_denies_read_only_creator_for_all_writes(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The creator can save an assignee-only change but not a content change."""

    from app.services.loop_items.external_provider import (
        external_loop_item_provider,
    )

    project = _make_external_project(test_db, test_user)
    creator = _make_member(test_db, project, "creator", BaseRole.Viewer)
    assignee = _make_member(test_db, project, "assignee", BaseRole.Developer)
    issue = _external_issue(f"wegent:creator:{creator.id}:creator")
    update_issue = MagicMock(return_value=issue)
    monkeypatch.setattr(
        external_loop_item_provider, "_get_issue", MagicMock(return_value=issue)
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_response",
        MagicMock(return_value=_external_response(can_view_detail=True)),
    )
    monkeypatch.setattr(external_loop_item_provider, "_update_issue", update_issue)
    monkeypatch.setattr(
        external_loop_item_provider, "_apply_assignee_executions", MagicMock()
    )

    with pytest.raises(HTTPException, match="Insufficient permission"):
        external_loop_item_provider.update(
            test_db,
            f"{project.project_key}-7",
            creator.id,
            LoopItemUpdate(
                version=1,
                assignee_user_id=assignee.id,
                notify_assignee=False,
            ),
        )

    update_issue.assert_not_called()

    with pytest.raises(HTTPException) as excinfo:
        external_loop_item_provider.update(
            test_db,
            f"{project.project_key}-7",
            creator.id,
            LoopItemUpdate(version=1, title="renamed"),
        )

    assert excinfo.value.status_code == 403
