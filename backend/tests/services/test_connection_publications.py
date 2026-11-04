"""Protocol tests for the private-source publication boundary."""

import json

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, ProjectIncomingEvent
from app.schemas.project_incoming_hook import ProjectIncomingHookCreate
from app.services.project_event_sources import (
    normalize_webhook_events,
    normalized_event_identity,
)
from app.services.project_incoming_hooks import project_incoming_hook_service
from tests.utils.collaboration import authorize_project


def publication() -> dict:
    return {
        "event_type": "connection.result_published",
        "resource": {"resource_type": "publication", "external_id": "rule-1"},
        "subject": {"id": "delivery-1"},
        "title": "Reported failure",
        "description": "An explicitly authorized problem summary",
    }


def test_publication_contains_only_the_authored_result() -> None:
    events = normalize_webhook_events("connection", publication(), {})
    assert len(events) == 1
    assert events[0].payload == {
        "title": "Reported failure",
        "description": "An explicitly authorized problem summary",
    }
    assert events[0].subject == {"type": "publication", "id": "delivery-1"}
    assert normalized_event_identity(events[0]) == normalized_event_identity(
        normalize_webhook_events("connection", publication(), {})[0]
    )


@pytest.mark.parametrize("field", ["source", "messages", "attachments", "credentials"])
def test_publication_rejects_private_source_envelopes(field: str) -> None:
    payload = {**publication(), field: {"private": "source data"}}
    assert normalize_webhook_events("connection", payload, {}) == []


@pytest.mark.parametrize(
    "patch",
    [
        {"subject": {"id": "delivery", "url": "private-message-link"}},
        {"title": ""},
        {"description": ""},
        {"title": "x" * 256},
        {"description": "x" * 32001},
        {"description": "文" * 11000},
        {"description": {"source": "private"}},
        {
            "resource": {
                "resource_type": "publication",
                "external_id": "rule",
                "profile": "private",
            }
        },
        {"event_type": "message.received"},
    ],
)
def test_invalid_publication_is_not_an_event(patch: dict) -> None:
    assert normalize_webhook_events("connection", {**publication(), **patch}, {}) == []


def test_subscription_uses_an_opaque_rule_reference_without_personal_accounts() -> None:
    value = ProjectIncomingHookCreate.model_validate(
        {
            "name": "Published results",
            "sourceType": "connection",
            "collectionMode": "webhook",
            "resource": {"resourceType": "publication", "externalId": "rule-1"},
        }
    )
    assert value.credential_ref is None
    assert value.resource.external_id == "rule-1"


@pytest.mark.asyncio
async def test_private_envelopes_are_rejected_before_project_event_persistence(
    test_db, test_user
) -> None:
    project = CloudProject(
        project_key="PUB",
        name="Publication",
        status="active",
        created_by_user_id=test_user.id,
        storage_prefix="projects/publication",
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.flush()
    hook = project_incoming_hook_service.create(
        test_db,
        str(project.id),
        test_user.id,
        ProjectIncomingHookCreate.model_validate(
            {
                "name": "Published results",
                "sourceType": "connection",
                "collectionMode": "webhook",
                "resource": {"resourceType": "publication", "externalId": "rule-1"},
            }
        ),
    )
    with pytest.raises(HTTPException) as error:
        await project_incoming_hook_service.receive(
            test_db,
            hook.public_id,
            json.dumps({**publication(), "messages": ["PRIVATE ORIGINAL"]}).encode(),
            "application/json",
            {},
        )
    assert error.value.status_code == 422
    assert (
        test_db.query(ProjectIncomingEvent)
        .filter_by(cloud_project_id=str(project.id))
        .count()
        == 0
    )

    body = json.dumps(publication()).encode()
    receipt = await project_incoming_hook_service.receive(
        test_db, hook.public_id, body, "application/json", {}
    )
    duplicate = await project_incoming_hook_service.receive(
        test_db, hook.public_id, body, "application/json", {}
    )
    assert receipt["status"] == "accepted"
    assert duplicate["status"] == "duplicate"
    assert duplicate["event_id"] == receipt["event_id"]
    stored = test_db.get(ProjectIncomingEvent, receipt["event_id"])
    assert stored.metadata_json["payload"] == publication()
    assert "PRIVATE ORIGINAL" not in json.dumps(stored.metadata_json)

    second = await project_incoming_hook_service.receive(
        test_db,
        hook.public_id,
        json.dumps({**publication(), "subject": {"id": "delivery-2"}}).encode(),
        "application/json",
        {},
    )
    exact = project_incoming_hook_service.list_events(
        test_db,
        str(project.id),
        str(hook.id),
        test_user.id,
        event_id=receipt["event_id"],
        limit=1,
    )
    assert [str(row.id) for row in exact] == [receipt["event_id"]]
    assert second["event_id"] != receipt["event_id"]
    assert (
        project_incoming_hook_service.list_events(
            test_db,
            str(project.id),
            str(hook.id),
            test_user.id,
            event_id="missing-receipt",
        )
        == []
    )
