"""A resumed manager owns a visible Issue session before asking for input."""

from datetime import datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException, Response

from app.api.endpoints.loop_item_executions import (
    report_collaboration_assignment_status,
)
from app.core.security import create_access_token
from app.models.delivery import Delivery, LoopItemTaskBinding
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.project_chat import LoopItemExecutionManagerStatus
from app.schemas.runtime_work import RuntimeTranscriptRequest
from app.services.collaboration_manager_activity import (
    project_collaboration_manager_activity,
)
from app.services.collaboration_round_assignment import assign_round_owner
from app.services.loop_item_executions.service import (
    WeworkRuntimeConfigurationError,
    loop_item_execution_service,
)
from app.services.project_chat.runtime_binding import resumed_manager_task_id
from app.services.project_chat.session_access import resolve_project_transcript
from app.services.runner_recovery import runner_recovery_available
from tests.services.test_project_comment_execution import scenario  # noqa: F401
from tests.services.test_project_group_comment_execution import (  # noqa: F401
    group_scenario,
    member_scenario,
)


@pytest.fixture
def resumed_manager(member_scenario):
    s = member_scenario
    s.issue.status = "in_progress"
    plan = s.db.query(ProjectChatMessage).filter_by(message_id="member-plan").one()
    assignments = [
        {**entry, "status": "completed", "agent_name": s.member_agent.name}
        for entry in plan.metadata_json["dispatch_assignments"]
    ]
    plan.metadata_json = {**plan.metadata_json, "dispatch_assignments": assignments}
    assign_round_owner(s.db, item=s.issue, assignments=assignments, user_id=s.owner.id)
    s.db.commit()
    values = LoopItemExecutionManagerStatus(
        role="manager",
        loop_item_id=s.issue.id,
        dispatch_id="group-dispatch-1",
        round_id="round-1",
        runtime_device_id="admin-native",
        runtime_task_id=f"{s.execution.runtime_task_id}-manager-initial-manager-after-round-1",
    )
    return s, values


def report(s, values):
    message, changed, _ = project_collaboration_manager_activity(
        s.db, project_id=s.project.id, user_id=s.owner.id, values=values
    )
    return message, changed


def test_replayed_resume_refreshes_profiles_only_while_authorized(
    resumed_manager, monkeypatch
):
    s, values = resumed_manager
    s.execution.status = "running"
    s.execution.assigner_user_id = s.member.id
    s.execution.execution_device_id = "admin-cloud"
    s.db.commit()
    values.refresh_runtime_profiles = True
    credentials = iter(("first", "renewed"))
    authorized = True
    available = False

    def compile_payload(db, *, execution, execution_target_id, executor_device_id):
        assert execution.id == s.execution.id
        assert execution.assigner_user_id == s.member.id
        assert execution_target_id == "admin-cloud"
        assert executor_device_id == s.execution.runtime_device_id
        if not available:
            raise WeworkRuntimeConfigurationError("Model unavailable")
        return {
            "managerRuntimeRequest": {
                "executionRequest": {
                    "model_config": {"api_key": next(credentials)},
                    "user_id": s.member.id,
                    "user_name": s.member.user_name,
                }
            },
            "memberRuntimeProfiles": [],
        }

    monkeypatch.setattr(
        "app.services.collaboration_revocation.execution_authorized",
        lambda db, execution: authorized,
    )
    monkeypatch.setattr(
        loop_item_execution_service, "build_executor_runtime_payload", compile_payload
    )
    monkeypatch.setattr(
        "app.api.endpoints.loop_item_executions.push_project_chat_message",
        lambda _: None,
    )
    http_response = Response()

    def request(token):
        return report_collaboration_assignment_status(
            s.project.id, values, http_response, s.db, s.owner, token
        )

    with pytest.raises(HTTPException) as missing_session:
        request(None)
    assert missing_session.value.status_code == 403

    with pytest.raises(HTTPException) as wrong_session:
        request(create_access_token({"sub": s.member.user_name}))
    assert wrong_session.value.status_code == 403

    session = create_access_token({"sub": s.owner.user_name})
    with pytest.raises(HTTPException) as unavailable:
        request(session)
    assert unavailable.value.status_code == 503

    available = True
    first = request(session)
    replay = request(session)
    assert http_response.headers["Cache-Control"] == "no-store"
    assert first["changed"] is True
    assert replay["changed"] is False
    assert first["message"] == replay["message"]
    assert first["runtime_profiles"]["manager_model_config"]["api_key"] == "first"
    assert replay["runtime_profiles"]["manager_model_config"]["api_key"] == "renewed"
    from app.services.auth import verify_task_token

    callback = verify_task_token(replay["runtime_profiles"]["manager_callback_token"])
    assert callback.user_id == s.member.id
    assert callback.device_manager_execution_id == s.execution.id
    assert "renewed" not in str(replay["message"])

    authorized = False
    with pytest.raises(HTTPException) as revoked:
        request(session)
    assert revoked.value.status_code == 403

    s.execution.status = "failed"
    s.db.commit()
    with pytest.raises(HTTPException) as terminal:
        request(session)
    assert terminal.value.status_code == 409


@pytest.mark.parametrize("dispatched_next_round", [False, True])
def test_expired_dispatch_reconciles_only_current_manager_failure(
    resumed_manager, dispatched_next_round
):
    s, values = resumed_manager
    activity, _ = report(s, values)
    activity.status = "failed"
    activity.content = "401 Unauthorized"
    s.execution.status = "claimed"
    s.execution.sync_state = "stale"
    s.execution.start_requested_at = datetime(2026, 11, 19, 7)
    s.execution.lease_expires_at = s.execution.start_requested_at + timedelta(minutes=5)
    if dispatched_next_round:
        plan = s.db.query(ProjectChatMessage).filter_by(message_id="member-plan").one()
        s.db.add(
            ProjectChatMessage(
                message_id="next-plan",
                project_id=str(s.project.id),
                task_id=s.issue.id,
                sender_type="agent",
                sender_id=s.agent.id,
                sender_name=s.agent.name,
                agent_id=s.agent.id,
                message_type="text",
                content="",
                metadata_json={
                    **plan.metadata_json,
                    "coordination_round_id": "round-2",
                    "manager_runtime_task_id": activity.runtime_task_id,
                },
                status="completed",
            )
        )
    s.db.commit()

    assert loop_item_execution_service.recovery_scan(
        s.db, now=datetime(2026, 11, 19, 8)
    ) == (0, 0)
    s.db.refresh(s.execution)
    assert s.execution.status == ("claimed" if dispatched_next_round else "failed")
    assert runner_recovery_available(s.db, s.issue.id) is not dispatched_next_round
    if not dispatched_next_round:
        assert s.execution.sync_state == "in_sync"
        assert s.execution.error_message == "401 Unauthorized"
        assert s.issue.status == "in_progress"


@pytest.mark.parametrize(
    "source,round_id,expected",
    [
        ("manager-task-1", "round-1", "manager-task-1-manager-after-round-1"),
        ("m" * 239, "r", f"{'m' * 239}-manager-after-r"),
        (
            "m" * 255,
            "r" * 128,
            "collaboration-manager-b3b830da1c050c0d6d371db96a2b2820336ee1574eb99ebd3c9dc86413358186",
        ),
        (
            "m" * 240,
            "澄清" * 20,
            "collaboration-manager-46bd8b428e70c1a5915f224e44ca0ea4cb3ec5ac484d1e3a9c6ed06caf07b0de",
        ),
        ("澄" * 200, "r", f"{'澄' * 200}-manager-after-r"),
    ],
)
def test_manager_id_encoding_matches_the_executor(source, round_id, expected):
    assert resumed_manager_task_id(source, round_id) == expected


def test_long_rounds_keep_exact_manager_transcripts_readable(resumed_manager):
    s, values = resumed_manager
    plan = s.db.query(ProjectChatMessage).filter_by(message_id="member-plan").one()
    template = dict(plan.metadata_json)
    source = f"{s.execution.runtime_task_id}-manager-initial"
    encoded = False
    for index in range(6):
        round_id = f"round-{index}-{'澄' * 120}"
        if index:
            plan = ProjectChatMessage(
                message_id=f"long-plan-{index}",
                project_id=str(s.project.id),
                task_id=s.issue.id,
                sender_type="agent",
                sender_id=s.agent.id,
                sender_name=s.agent.name,
                agent_id=s.agent.id,
                message_type="text",
                content="",
                status="completed",
            )
            s.db.add(plan)
        plan.metadata_json = {
            **template,
            "coordination_round_id": round_id,
            "manager_runtime_task_id": source,
        }
        s.db.commit()
        source = resumed_manager_task_id(source, round_id)
        values = LoopItemExecutionManagerStatus.model_validate(
            {**values.model_dump(), "round_id": round_id, "runtime_task_id": source}
        )
        message, created = report(s, values)
        assert created
        assert message.runtime_task_id == source
        owner, address = resolve_project_transcript(
            s.db,
            s.member.id,
            RuntimeTranscriptRequest(
                deviceId=values.runtime_device_id,
                taskId=source,
                projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
            ),
        )
        assert owner == s.owner.id
        assert address.local_task_id == source
        assert len(source) <= 255
        encoded |= source.startswith("collaboration-manager-")
    assert encoded
    assert s.db.query(LoopItemTaskBinding).count() == 6


@pytest.mark.parametrize("reuse_session", [True, False])
def test_resume_returns_owner_and_exposes_the_exact_manager_transcript(
    resumed_manager, reuse_session
):
    s, values = resumed_manager
    if reuse_session:
        values.runtime_task_id = f"{s.execution.runtime_task_id}-manager-initial"
    assert s.issue.assignee_agent_id == s.member_agent.id

    message, created = report(s, values)

    assert created
    assert s.issue.assignee_agent_id == s.agent.id
    handoff = s.issue.metadata_json["assignment_history"][-1]
    assert handoff["by_agent_id"] == s.agent.id
    assert handoff["by_agent_name"] == (s.agent.title or s.agent.name)
    assert handoff["by_user_id"] == s.execution.assigner_user_id
    assert s.issue.status == "in_progress"
    assert message.agent_id == s.agent.id
    assert message.runtime_task_id == values.runtime_task_id
    assert message.metadata_json["activity_type"] == "manager_execution"
    binding = s.db.query(LoopItemTaskBinding).one()
    assert binding.task_id == values.runtime_task_id
    owner, address = resolve_project_transcript(
        s.db,
        s.member.id,
        RuntimeTranscriptRequest(
            deviceId=values.runtime_device_id,
            taskId=values.runtime_task_id,
            projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
        ),
    )
    assert owner == s.owner.id
    assert address.local_task_id == values.runtime_task_id
    s.rpc.assert_not_called()


def test_replayed_resume_does_not_steal_ownership_from_the_next_batch(resumed_manager):
    s, values = resumed_manager
    message, _ = report(s, values)
    assign_round_owner(
        s.db,
        item=s.issue,
        assignments=[
            {
                "assignee_type": "agent",
                "agent_id": s.member_agent.id,
                "agent_name": s.member_agent.name,
            }
        ],
        user_id=s.owner.id,
    )
    s.db.commit()
    version = s.issue.version

    replay, created = report(s, values)

    assert replay.message_id == message.message_id
    assert not created
    assert s.issue.assignee_agent_id == s.member_agent.id
    assert s.issue.version == version
    assert s.db.query(LoopItemTaskBinding).count() == 1


def test_deleted_issue_cannot_resume_its_manager(resumed_manager):
    s, values = resumed_manager
    s.issue.deleted_at = datetime.now()
    s.db.commit()

    with pytest.raises(HTTPException) as error:
        report(s, values)

    assert error.value.status_code == 404
    assert s.db.query(LoopItemTaskBinding).count() == 0


@pytest.mark.parametrize(
    "field,value,code",
    [
        ("runtime_task_id", "unrelated-task", 409),
        ("round_id", "unrelated-round", 409),
        ("runtime_device_id", "unrelated-device", 403),
    ],
)
def test_resume_rejects_unrecorded_execution_identities(
    resumed_manager, field, value, code
):
    s, values = resumed_manager
    with pytest.raises(HTTPException) as caught:
        report(s, values.model_copy(update={field: value}))
    assert caught.value.status_code == code
    assert s.issue.assignee_agent_id == s.member_agent.id
    assert s.db.query(LoopItemTaskBinding).count() == 0


def test_resume_rejects_a_round_still_waiting_for_a_member(resumed_manager):
    s, values = resumed_manager
    plan = s.db.query(ProjectChatMessage).filter_by(message_id="member-plan").one()
    plan.metadata_json = {
        **plan.metadata_json,
        "dispatch_assignments": [{"status": "running"}],
    }
    with pytest.raises(HTTPException) as caught:
        report(s, values)
    assert caught.value.status_code == 409
    assert s.issue.assignee_agent_id == s.member_agent.id


@pytest.mark.parametrize("field", ["agent_id", "sender_id"])
def test_shared_manager_transcript_requires_recorded_dispatch_identity(
    resumed_manager, field
):
    s, values = resumed_manager
    message, _ = report(s, values)
    setattr(message, field, "unrelated-agent")
    s.db.commit()

    with pytest.raises(HTTPException) as caught:
        resolve_project_transcript(
            s.db,
            s.member.id,
            RuntimeTranscriptRequest(
                deviceId=values.runtime_device_id,
                taskId=values.runtime_task_id,
                projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
            ),
        )
    assert caught.value.status_code == 404


def test_a_manual_binding_does_not_grant_shared_manager_transcript_access(
    resumed_manager,
):
    s, values = resumed_manager
    message, _ = report(s, values)
    message.metadata_json = {"activity_type": "manual_binding"}
    s.db.commit()

    with pytest.raises(HTTPException) as caught:
        resolve_project_transcript(
            s.db,
            s.member.id,
            RuntimeTranscriptRequest(
                deviceId=values.runtime_device_id,
                taskId=values.runtime_task_id,
                projectSession={"projectId": str(s.project.id), "issueId": s.issue.id},
            ),
        )
    assert caught.value.status_code == 404


@pytest.mark.parametrize("delivered", [False, True])
def test_resume_checks_human_delivery_instead_of_the_original_queued_card(
    resumed_manager, monkeypatch, delivered
):
    s, values = resumed_manager
    plan = s.db.query(ProjectChatMessage).filter_by(message_id="member-plan").one()
    plan.metadata_json = {
        **plan.metadata_json,
        "dispatch_assignments": [
            {
                "assignee_type": "human",
                "human_assignment_id": "review-work",
                "status": "queued",
            }
        ],
    }
    binding = LoopItemTaskBinding(
        id=str(uuid4()),
        cloud_project_id=str(s.project.id),
        loop_item_id=s.issue.id,
        task_user_id=s.member.id,
        device_id="human-device",
        task_id="human-task",
        metadata_json={"human_assignment_id": "review-work"},
    )
    s.db.add(binding)
    if delivered:
        s.db.add(
            Delivery(
                id=str(uuid4()),
                loop_item_id=s.issue.id,
                created_by_user_id=s.member.id,
                source_task_binding_id=binding.id,
                status="delivered",
                delivered_at=datetime.now(),
                markdown_object_key="review.md",
            )
        )
    s.db.commit()
    monkeypatch.setattr(
        "app.services.delivery.service.delivery_service.read_markdown",
        lambda _: "Verified",
    )
    if delivered:
        message, created = report(s, values)
        assert created
        assert message.runtime_task_id == values.runtime_task_id
        assert s.issue.assignee_agent_id == s.agent.id
    else:
        with pytest.raises(HTTPException) as caught:
            report(s, values)
        assert caught.value.status_code == 409
