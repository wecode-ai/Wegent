# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API coverage for project incoming hooks."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

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


def test_incoming_hook_persists_event_before_routing_and_deduplicates(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    created_hook = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={"name": "GitHub"},
    )
    assert created_hook.status_code == 201
    hook = created_hook.json()
    assert hook["name"] == "GitHub"
    assert hook["status"] == "active"
    assert "/api/v1/incoming-hooks/" in hook["webhook_url"]

    payload = {
        "action": "opened",
        "issue": {
            "id": 42,
            "number": 7,
            "title": "External issue",
            "body": "Created outside Wework",
            "html_url": "https://github.example/acme/app/issues/7",
        },
        "repository": {"full_name": "acme/app"},
    }
    first = test_client.post(
        hook["webhook_url"],
        headers={"X-GitHub-Event": "issues", "X-GitHub-Delivery": "delivery-1"},
        json=payload,
    )
    assert first.status_code == 202
    receipt = first.json()
    assert receipt["status"] == "received"
    assert receipt["provider"] == "github"
    assert receipt["loop_item_id"] is None
    event = test_db.get(ProjectIncomingEvent, receipt["event_id"])
    assert event.title == "External issue"
    assert event.status == "waiting_configuration"
    assert (
        event.metadata_json["reference"]["external_id"]
        == "https://github.example/acme/app/issues/7"
    )

    duplicate = test_client.post(
        hook["webhook_url"],
        headers={"X-GitHub-Event": "issues", "X-GitHub-Delivery": "delivery-1"},
        json=payload,
    )
    assert duplicate.status_code == 202
    assert duplicate.json()["status"] == "duplicate"
    assert duplicate.json()["loop_item_id"] == receipt["loop_item_id"]
    assert (
        test_db.query(LoopItem)
        .filter(LoopItem.cloud_project_id == project["id"])
        .count()
        == 0
    )
    assert test_db.query(ProjectIncomingEvent).count() == 1


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
    assert response.json()["status"] == "received"
    assert response.json()["reason"] is None
    assert test_db.query(LoopItem).count() == 0
    event = test_db.query(ProjectIncomingEvent).one()
    assert event.status == "waiting_configuration"


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
