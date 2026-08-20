# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API coverage for project incoming hooks."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import LoopItem, ProjectIncomingEvent, ProjectIncomingHook


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(test_client: TestClient, token: str) -> dict[str, object]:
    response = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(token),
        json={"project_key": "HOOK", "name": "Incoming hook project"},
    )
    assert response.status_code == 201
    return response.json()


def test_incoming_hook_buffers_unmatched_event_and_deduplicates(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    created_hook = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={"name": "GitLab"},
    )
    assert created_hook.status_code == 201
    hook = created_hook.json()
    assert hook["name"] == "GitLab"
    assert hook["status"] == "active"
    assert "/api/v1/incoming-hooks/" in hook["webhook_url"]

    payload = {
        "object_kind": "merge_request",
        "object_attributes": {
            "id": 42,
            "iid": 7,
            "action": "merge",
            "url": "https://gitlab.example/acme/app/-/merge_requests/7",
        },
        "project": {"path_with_namespace": "acme/app"},
    }
    first = test_client.post(
        hook["webhook_url"],
        headers={
            "X-GitLab-Event": "Merge Request Hook",
            "X-GitLab-Event-UUID": "delivery-1",
        },
        json=payload,
    )
    assert first.status_code == 202
    receipt = first.json()
    assert receipt["status"] == "buffered"
    assert receipt["provider"] == "gitlab"
    assert receipt["loop_item_id"] is None

    duplicate = test_client.post(
        hook["webhook_url"],
        headers={
            "X-GitLab-Event": "Merge Request Hook",
            "X-GitLab-Event-UUID": "delivery-1",
        },
        json=payload,
    )
    assert duplicate.status_code == 202
    assert duplicate.json()["status"] == "duplicate"
    assert duplicate.json()["event_id"] == receipt["event_id"]
    assert test_db.query(LoopItem).count() == 0
    event = test_db.query(ProjectIncomingEvent).one()
    assert event.status == "buffered"
    assert event.title == "MR !7 merged"
    assert event.metadata_json.get("event_type") == "merged"
    assert event.metadata_json.get("opaque_ref") == "acme/app!7"
    from app.services.external_events.buffer import external_event_buffer

    external_event_buffer.clear()


def test_incoming_hook_url_uses_configured_public_base(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "WEGENT_BACKEND_PUBLIC_URL", "https://hooks.example.com"
    )
    project = _project(test_client, test_token)
    hook = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={"name": "Public"},
    )
    assert hook.status_code == 201
    assert hook.json()["webhook_url"].startswith(
        "https://hooks.example.com/api/v1/incoming-hooks/"
    )


def test_incoming_hook_records_unrecognized_payload_without_creating_issue(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    hook = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={"name": "Generic"},
    ).json()

    response = test_client.post(hook["webhook_url"], json={"unknown": True})

    assert response.status_code == 202
    assert response.json()["status"] == "ignored"
    assert response.json()["reason"] == "no supported external event detected"
    assert test_db.query(LoopItem).count() == 0
    event = test_db.query(ProjectIncomingEvent).one()
    assert event.status == "ignored"


def test_disabled_and_rotated_incoming_hook_invalidates_old_address(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    hook = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={"name": "Deployments"},
    ).json()
    old_url = hook["webhook_url"]

    rotated = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks/{hook['id']}/rotate",
        headers=_auth(test_token),
    )
    assert rotated.status_code == 200
    assert rotated.json()["webhook_url"] != old_url
    assert test_client.post(old_url, json={"title": "Old"}).status_code == 404

    disabled = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks/{hook['id']}",
        headers=_auth(test_token),
        json={"version": rotated.json()["version"], "status": "disabled"},
    )
    assert disabled.status_code == 200
    assert (
        test_client.post(
            disabled.json()["webhook_url"], json={"title": "Disabled"}
        ).status_code
        == 410
    )
    stored = test_db.get(ProjectIncomingHook, hook["id"])
    assert stored is not None
    assert stored.status == "disabled"
