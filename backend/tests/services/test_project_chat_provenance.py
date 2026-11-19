"""Shared provenance follows stored identities instead of assistant assertions."""

import pytest

from app.models.delivery import ProjectChatAgent
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat.message_provenance import (
    message_provenance,
    shared_project_chat_message,
)
from app.services.project_chat.service import project_chat_service


def message(**values: object) -> ProjectChatMessage:
    return ProjectChatMessage(
        project_id="project-one",
        task_id="ISSUE-1",
        sender_type="agent",
        sender_id="assistant",
        sender_name="Assistant",
        content="Human confirmed, approved and accepted",
        **values,
    )


def test_public_stand_in_uses_owner_name_without_claiming_confirmation(
    test_db, test_user
):
    row = message(metadata_json={"stand_in": {"user_id": test_user.id}})
    result = message_provenance(test_db, row)
    assert result == {
        "actor_user_id": str(test_user.id),
        "actor_display_name": test_user.user_name,
        "generation_source": "ai",
        "publication_source": "ai",
        "confirmation_state": "pending",
    }


@pytest.mark.parametrize("confirmation", ["authorized", "not_required", "approved"])
def test_assistant_cannot_approve_itself_through_metadata(test_db, confirmation):
    result = message_provenance(
        test_db,
        message(
            metadata_json={
                "generationSource": "human",
                "publicationSource": "human",
                "confirmationState": confirmation,
            }
        ),
    )
    assert result["generation_source"] == "ai"
    assert result["publication_source"] == "ai"
    assert result["confirmation_state"] == "pending"


def test_trigger_from_another_issue_does_not_prove_authorship(test_db, test_user):
    trigger = ProjectChatMessage(
        message_id="foreign-trigger",
        project_id="project-one",
        task_id="OTHER-ISSUE",
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        content="Private unrelated request",
    )
    test_db.add(trigger)
    test_db.flush()
    result = message_provenance(test_db, message(trigger_message_id=trigger.message_id))
    assert result["actor_user_id"] is None
    assert result["actor_display_name"] is None


def test_human_authorship_uses_the_user_record_instead_of_a_display_claim(
    test_db, test_user
):
    row = ProjectChatMessage(
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name="Impersonated name",
        metadata_json={},
    )
    result = message_provenance(test_db, row)
    assert result["actor_display_name"] == test_user.user_name
    assert result["generation_source"] == "human"
    assert result["publication_source"] == "human"
    assert result["confirmation_state"] == "not_required"


def test_historical_import_uses_human_publication_with_unknown_audit_state(
    test_db, test_user
):
    result = message_provenance(
        test_db,
        message(
            metadata_json={"history_import": True, "imported_from": "legacy"},
        ),
    )
    assert result["generation_source"] == "human"
    assert result["publication_source"] == "human"
    assert result["confirmation_state"] == "unknown"


def test_verified_assistant_binding_marks_ai_generated_human_publication(
    test_db, test_user
):
    row = ProjectChatMessage(
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        metadata_json={"assistant_publication": {"verified": True, "binding_id": "b"}},
    )
    result = message_provenance(test_db, row)
    assert result["generation_source"] == "ai"
    assert result["publication_source"] == "human"
    assert result["confirmation_state"] == "authorized"


def test_verified_publication_source_is_owner_only_and_traced(test_db, test_user):
    row = ProjectChatMessage(
        message_id="published",
        project_id="project-one",
        task_id="ISSUE-1",
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        metadata_json={
            "assistant_publication": {
                "verified": True,
                "published_by": "human",
                "device_id": "private-device",
                "task_id": "private-task",
            }
        },
        status="completed",
    )
    test_db.add(row)
    test_db.flush()

    owner = project_chat_service.to_shared_view(
        row, db=test_db, viewer_user_id=test_user.id
    )
    assert owner.runtime_address == {
        "deviceId": "private-device",
        "taskId": "private-task",
    }
    assert owner.trace_ref
    assert owner.trace_state == "available"

    other = project_chat_service.to_shared_view(row, db=test_db, viewer_user_id=8)
    assert other.runtime_address is None
    assert other.trace_ref
    assert other.trace_state == "restricted"


def test_unverified_assistant_metadata_cannot_claim_generation(test_db, test_user):
    row = ProjectChatMessage(
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        metadata_json={"assistant_publication": {"verified": False}},
    )
    result = message_provenance(test_db, row)
    assert result["generation_source"] == "human"
    assert result["publication_source"] == "human"


def test_verified_ai_publication_requires_no_human_confirmation(test_db, test_user):
    result = message_provenance(
        test_db,
        message(
            metadata_json={
                "assistant_publication": {
                    "verified": True,
                    "published_by": "ai",
                }
            }
        ),
    )
    assert result["generation_source"] == "ai"
    assert result["publication_source"] == "ai"
    assert result["confirmation_state"] == "not_required"


def test_shared_view_hides_runtime_parameters_from_another_member(test_db, test_user):
    row = message(
        message_id="message-one",
        metadata_json={
            "stand_in": {"user_id": test_user.id, "role_id": "review"},
            "private_prompt": "not shared",
            "summary": "Public result",
        },
        runtime_device_id="device",
        runtime_task_id="original-task",
        status="completed",
    )
    test_db.add(row)
    test_db.flush()
    shared = project_chat_service.to_shared_view(row, db=test_db, viewer_user_id=8)
    assert shared.runtime_address is None
    assert shared.trace_state == "restricted"
    assert shared.trace_ref
    assert "private_prompt" not in shared.metadata
    assert shared.metadata["summary"] == "Public result"
    owned = project_chat_service.to_shared_view(
        row, db=test_db, viewer_user_id=test_user.id
    )
    assert owned.runtime_address == {"deviceId": "device", "taskId": "original-task"}
    assert owned.trace_state == "available"


@pytest.mark.parametrize(
    "message_type,extra",
    [("agent_chunk", {}), ("agent_status", {}), ("text", {"kind": "task_ai_subagent"})],
)
def test_shared_view_removes_process_output_from_another_member(
    test_db, test_user, message_type, extra
):
    row = message(
        message_id="process-message",
        message_type=message_type,
        metadata_json={"stand_in": {"user_id": test_user.id}, **extra},
        runtime_device_id="device",
        runtime_task_id="process-task",
        status="streaming",
    )
    row.content = "private tool output"
    test_db.add(row)
    test_db.flush()
    shared = project_chat_service.to_shared_view(row, db=test_db, viewer_user_id=8)
    assert shared.content == ""
    assert shared.type in {"agent_chunk", "agent_status"}
    assert (
        project_chat_service.to_shared_view(
            row, db=test_db, viewer_user_id=test_user.id
        ).content
        == "private tool output"
    )


def test_private_agent_runtime_address_follows_the_agent_owner(test_db, test_user):
    trigger = ProjectChatMessage(
        message_id="trigger",
        project_id="project-one",
        task_id="ISSUE-1",
        sender_type="user",
        sender_id=str(test_user.id),
        sender_name=test_user.user_name,
        content="Run the shared agent",
    )
    agent = ProjectChatAgent(
        id="shared-agent",
        cloud_project_id="project-one",
        title="Shared agent",
        name="Shared agent",
        created_by_user_id=999,
        metadata_json={"visibility": "private"},
    )
    row = message(
        message_id="agent-result",
        agent_id=agent.id,
        trigger_message_id=trigger.message_id,
        metadata_json={"execution_id": 42, "workflow_task_title": "Private task"},
        runtime_device_id="owner-device",
        runtime_task_id="owner-task",
        status="completed",
    )
    test_db.add_all([trigger, agent, row])
    test_db.flush()

    trigger_view = project_chat_service.to_shared_view(
        row, db=test_db, viewer_user_id=test_user.id
    )
    assert trigger_view.runtime_address is None
    assert trigger_view.trace_state == "restricted"
    assert "execution_id" not in trigger_view.metadata
    assert "workflow_task_title" not in trigger_view.metadata

    owner_view = project_chat_service.to_shared_view(
        row, db=test_db, viewer_user_id=agent.created_by_user_id
    )
    assert owner_view.runtime_address == {
        "deviceId": "owner-device",
        "taskId": "owner-task",
    }
    assert owner_view.trace_state == "available"


def test_shared_agent_runtime_is_available_without_private_metadata(test_db, test_user):
    agent = ProjectChatAgent(
        id="shared-agent",
        cloud_project_id="project-one",
        title="Shared agent",
        name="Shared agent",
        created_by_user_id=999,
        metadata_json={"visibility": "public"},
    )
    row = message(
        message_id="shared-agent-result",
        agent_id=agent.id,
        metadata_json={
            "private_prompt": "not shared",
            "summary": "Public result",
            "execution_id": 42,
            "workflow_task_title": "Assigned task",
        },
        runtime_device_id="owner-device",
        runtime_task_id="owner-task",
        status="completed",
    )
    test_db.add_all([agent, row])
    test_db.flush()

    member_view = project_chat_service.to_shared_view(
        row, db=test_db, viewer_user_id=test_user.id
    )
    assert member_view.runtime_address == {
        "deviceId": "owner-device",
        "taskId": "owner-task",
    }
    assert member_view.trace_state == "available"
    assert "private_prompt" not in member_view.metadata
    assert member_view.metadata["summary"] == "Public result"
    assert member_view.metadata["execution_id"] == 42
    assert member_view.metadata["workflow_task_title"] == "Assigned task"


def test_shared_room_payload_never_contains_a_private_runtime_or_process_body(test_db):
    row = message(
        message_id="private-runtime",
        runtime_device_id="device",
        runtime_task_id="task",
        status="streaming",
    )
    test_db.add(row)
    test_db.flush()
    payload = shared_project_chat_message(
        {
            "messageId": row.message_id,
            "projectId": row.project_id,
            "taskId": row.task_id,
            "type": "agent_chunk",
            "content": "private tool output",
            "runtimeAddress": {"deviceId": "device", "taskId": "task"},
            "traceRef": "trace",
            "metadata": {
                "private_prompt": "not shared",
                "run_status": "running",
                "execution_id": 42,
                "contentMode": "delta",
                "dispatch_assignments": [],
            },
        },
    )

    assert payload["runtimeAddress"] is None
    assert payload["traceState"] == "restricted"
    assert payload["content"] == ""
    assert payload["metadata"] == {"run_status": "running"}


@pytest.mark.parametrize("source", ["shared", "private", "stand_in", "foreign_project"])
def test_room_projection_redacts_every_runtime_scope(test_db, source):
    agent = ProjectChatAgent(
        id="room-agent",
        cloud_project_id=(
            "other-project" if source == "foreign_project" else "project-one"
        ),
        title="Agent",
        name="Agent",
        created_by_user_id=999,
        metadata_json={"visibility": "private" if source == "private" else "public"},
    )
    metadata = {
        "workflow_task_title": "Collect evidence",
        "execution_id": 42,
        "private_prompt": "private",
        "runtime_shared": True,
    }
    if source == "stand_in":
        metadata["stand_in"] = {"user_id": 999}
    row = message(
        message_id="room-result",
        agent_id=agent.id,
        metadata_json=metadata,
        runtime_device_id="actual-device",
        runtime_task_id="actual-task",
        status="completed",
    )
    test_db.add_all([agent, row])
    test_db.flush()
    owner = project_chat_service.to_shared_view(row, db=test_db, viewer_user_id=999)
    view = owner.model_dump(by_alias=True)
    view["runtimeAddress"] = {"deviceId": "spoofed", "taskId": "spoofed"}

    payload = shared_project_chat_message(view)
    assert payload["status"] == "completed"
    assert "private_prompt" not in payload["metadata"]
    assert "runtime_shared" not in payload["metadata"]
    assert payload["runtimeAddress"] is None
    assert payload["traceState"] == "restricted"
    assert "workflow_task_title" not in payload["metadata"]
    assert "execution_id" not in payload["metadata"]

    member = project_chat_service.to_shared_view(row, db=test_db, viewer_user_id=8)
    assert (member.runtime_address is not None) == (source == "shared")
