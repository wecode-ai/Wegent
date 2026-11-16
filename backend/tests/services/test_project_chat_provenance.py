"""Shared provenance follows stored identities instead of assistant assertions."""

import pytest

from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat.message_provenance import message_provenance
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


def test_shared_view_removes_process_output_from_another_member(test_db, test_user):
    row = message(
        message_id="process-message",
        message_type="agent_chunk",
        metadata_json={"stand_in": {"user_id": test_user.id}},
        runtime_device_id="device",
        runtime_task_id="process-task",
        status="streaming",
    )
    row.content = "private tool output"
    test_db.add(row)
    test_db.flush()
    shared = project_chat_service.to_shared_view(row, db=test_db, viewer_user_id=8)
    assert shared.content == ""
