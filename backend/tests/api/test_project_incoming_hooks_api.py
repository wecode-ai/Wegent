# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API coverage for project event subscriptions."""

import asyncio
import hashlib
import hmac
import json
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    ProjectAutomationRun,
    ProjectIncomingEvent,
    ProjectIncomingHook,
)
from app.models.user import User
from app.services.connector_connections import connector_connection_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_event_polling import PolledInput, PollPage
from app.services.project_event_polling_service import project_event_polling_service
from app.services.project_incoming_hooks import project_incoming_hook_service


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(test_client: TestClient, token: str) -> dict[str, object]:
    response = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(token),
        json={"project_key": "HOOK", "name": "Event subscription project"},
    )
    assert response.status_code == 201
    return response.json()


def _github_subscription(
    test_client: TestClient,
    token: str,
    project_id: str,
) -> dict[str, object]:
    response = test_client.post(
        f"/api/v1/cloud-projects/{project_id}/incoming-hooks",
        headers=_auth(token),
        json={
            "name": "GitHub repository",
            "source_type": "github",
            "collection_mode": "webhook",
            "resource": {
                "resource_type": "repository",
                "url": "https://github.example/acme/app",
            },
        },
    )
    assert response.status_code == 201
    return response.json()


def _connect_github(test_db: Session, test_user: User) -> None:
    connector_connection_service.save_oauth_connection(
        test_db,
        slug="github",
        user_id=test_user.id,
        access_token="github-token",
        refresh_token=None,
        token_type="bearer",
        granted_scopes=["repo"],
        external_account_name="octocat",
        expires_at=None,
    )


def _github_headers(
    payload: dict[str, object],
    secret: str,
    *,
    delivery_id: str,
) -> dict[str, str]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-GitHub-Event": "check_run",
        "X-GitHub-Delivery": delivery_id,
        "X-Hub-Signature-256": f"sha256={signature}",
    }


def _failed_check_payload() -> dict[str, object]:
    return {
        "action": "completed",
        "check_run": {
            "id": 100,
            "status": "completed",
            "conclusion": "failure",
            "head_sha": "abc1234",
            "pull_requests": [
                {
                    "number": 7,
                    "html_url": "https://github.example/acme/app/pull/7",
                    "head": {"ref": "fix/checks", "sha": "abc1234"},
                    "base": {"ref": "main"},
                }
            ],
        },
        "repository": {
            "id": 42,
            "full_name": "acme/app",
            "html_url": "https://github.example/acme/app",
        },
    }


def test_subscription_persists_normalizes_and_deduplicates_input(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))
    assert hook["sourceType"] == "github"
    assert hook["collectionMode"] == "webhook"
    assert hook["webhookUrl"]
    assert hook["webhookSecret"]

    payload = _failed_check_payload()
    body = json.dumps(payload, separators=(",", ":"))
    first = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(
            payload,
            str(hook["webhookSecret"]),
            delivery_id="delivery-1",
        ),
        content=body,
    )
    assert first.status_code == 202
    assert first.json()["status"] == "accepted"

    event = test_db.get(ProjectIncomingEvent, first.json()["eventId"])
    assert event is not None
    assert event.status == "received"

    asyncio.run(project_incoming_hook_service.process_event(test_db, str(event.id)))
    test_db.refresh(event)
    assert event.status == "processed"
    assert event.metadata_json["normalized_events"][0]["event_type"] == (
        "change_request.checks_failed"
    )
    assert test_db.query(LoopItem).count() == 0

    duplicate = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(
            payload,
            str(hook["webhookSecret"]),
            delivery_id="delivery-1",
        ),
        content=body,
    )
    assert duplicate.status_code == 202
    assert duplicate.json()["status"] == "duplicate"
    assert duplicate.json()["eventId"] == first.json()["eventId"]
    assert test_db.query(ProjectIncomingEvent).count() == 1


def test_subscription_rejects_invalid_signature(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))

    response = test_client.post(
        str(hook["webhookUrl"]),
        headers={
            "X-GitHub-Event": "check_run",
            "X-GitHub-Delivery": "delivery-invalid",
            "X-Hub-Signature-256": "sha256=invalid",
        },
        json=_failed_check_payload(),
    )

    assert response.status_code == 401
    assert test_db.query(ProjectIncomingEvent).count() == 0


def test_subscription_event_matches_external_rule_and_creates_one_run(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch,
) -> None:
    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))
    rule_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Track failed checks",
            "prompt": "Investigate the failed checks.",
            "triggerType": "event",
            "eventType": "change_request.checks_failed",
            "eventConfig": {
                "subscription_id": hook["id"],
                "execution_target": "create_issue",
                "target_branches": ["main"],
            },
            "assignmentMode": "manual",
            "roleSource": "generic",
            "runtimeSource": "runtime_user",
            "runtimeUserId": test_user.id,
        },
    )
    assert rule_response.status_code == 201, rule_response.text
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    payload = _failed_check_payload()
    body = json.dumps(payload, separators=(",", ":"))
    response = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(
            payload,
            str(hook["webhookSecret"]),
            delivery_id="delivery-rule-match",
        ),
        content=body,
    )
    assert response.status_code == 202

    asyncio.run(
        project_incoming_hook_service.process_event(
            test_db,
            response.json()["eventId"],
        )
    )

    run = test_db.query(ProjectAutomationRun).one()
    assert run.parent_id == rule_response.json()["id"]
    assert run.status == "pending"
    assert run.task_id
    assert test_db.get(LoopItem, run.task_id) is not None
    dispatch.assert_awaited_once()


def test_disabled_and_rotated_subscription_invalidates_old_address(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))
    old_url = str(hook["webhookUrl"])

    rotated = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks/{hook['id']}/rotate",
        headers=_auth(test_token),
    )
    assert rotated.status_code == 200
    assert rotated.json()["webhookUrl"] != old_url
    assert rotated.json()["webhookSecret"]
    assert test_client.post(old_url, json={}).status_code == 404

    disabled = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks/{hook['id']}",
        headers=_auth(test_token),
        json={"version": rotated.json()["version"], "status": "disabled"},
    )
    assert disabled.status_code == 200
    assert (
        test_client.post(
            disabled.json()["webhookUrl"],
            json={},
        ).status_code
        == 410
    )
    stored = test_db.get(ProjectIncomingHook, hook["id"])
    assert stored is not None
    assert stored.status == "disabled"


def test_poll_subscription_requires_a_connected_credential(
    test_client: TestClient,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={
            "name": "GitHub polling",
            "source_type": "github",
            "collection_mode": "poll",
            "credential_ref": "github",
            "resource": {
                "resource_type": "repository",
                "url": "https://github.com/acme/app",
            },
            "poll_interval_seconds": 300,
        },
    )

    assert response.status_code == 422
    assert "not connected" in response.json()["detail"]


def test_poll_subscription_can_switch_to_hybrid_and_exposes_webhook_credentials(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
) -> None:
    project = _project(test_client, test_token)
    _connect_github(test_db, test_user)
    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={
            "name": "GitHub polling",
            "source_type": "github",
            "collection_mode": "poll",
            "credential_ref": "github",
            "resource": {
                "resource_type": "repository",
                "url": "https://github.com/acme/app",
            },
            "poll_interval_seconds": 300,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["collectionMode"] == "poll"
    assert created.json()["webhookUrl"] is None
    assert created.json()["webhookSecret"] is None

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks/{created.json()['id']}",
        headers=_auth(test_token),
        json={
            "version": created.json()["version"],
            "collection_mode": "hybrid",
        },
    )

    assert updated.status_code == 200, updated.text
    assert updated.json()["collectionMode"] == "hybrid"
    assert updated.json()["webhookUrl"]
    assert updated.json()["webhookSecret"]

    payload = _failed_check_payload()
    delivery = test_client.post(
        str(updated.json()["webhookUrl"]),
        headers=_github_headers(
            payload,
            str(updated.json()["webhookSecret"]),
            delivery_id="delivery-after-upgrade",
        ),
        content=json.dumps(payload, separators=(",", ":")),
    )
    assert delivery.status_code == 202
    assert delivery.json()["status"] == "accepted"


def test_hybrid_webhook_and_poll_inputs_share_one_automation_run(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch,
) -> None:
    project = _project(test_client, test_token)
    _connect_github(test_db, test_user)
    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={
            "name": "GitHub hybrid",
            "source_type": "github",
            "collection_mode": "hybrid",
            "credential_ref": "github",
            "resource": {
                "resource_type": "repository",
                "url": "https://github.example/acme/app",
            },
            "poll_interval_seconds": 300,
        },
    )
    assert created.status_code == 201, created.text
    hook = created.json()
    rule_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Track failed checks",
            "prompt": "Investigate the failed checks.",
            "triggerType": "event",
            "eventType": "change_request.checks_failed",
            "eventConfig": {
                "subscription_id": hook["id"],
                "execution_target": "create_issue",
                "target_branches": ["main"],
            },
            "assignmentMode": "manual",
            "roleSource": "generic",
            "runtimeSource": "runtime_user",
            "runtimeUserId": test_user.id,
        },
    )
    assert rule_response.status_code == 201, rule_response.text

    payload = _failed_check_payload()
    delivery = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(
            payload,
            str(hook["webhookSecret"]),
            delivery_id="hybrid-delivery",
        ),
        content=json.dumps(payload, separators=(",", ":")),
    )
    assert delivery.status_code == 202
    asyncio.run(
        project_incoming_hook_service.process_event(
            test_db,
            delivery.json()["eventId"],
        )
    )
    assert test_db.query(ProjectAutomationRun).count() == 1

    check = dict(payload["check_run"])

    class FakePoller:
        async def fetch_page(self, *, resource, credential, cursor):
            assert resource["path"] == "acme/app"
            assert credential == "github-token"
            return PollPage(
                inputs=(
                    PolledInput(
                        identity=(
                            f"check_run:{check['id']}:failure:{check['head_sha']}"
                        ),
                        title="github: check_run #7",
                        payload={
                            "action": "completed",
                            "check_run": check,
                            "repository": {
                                "id": 42,
                                "full_name": "acme/app",
                                "html_url": "https://github.example/acme/app",
                            },
                        },
                        headers={"x-github-event": "check_run"},
                    ),
                ),
                next_cursor={"watermark": "2026-01-01T00:00:00Z", "page": 1},
                complete=True,
            )

    monkeypatch.setattr(
        "app.services.project_event_polling_service.poller_for",
        lambda _source_type: FakePoller(),
    )
    discovered = asyncio.run(
        project_event_polling_service.poll_subscription(test_db, hook["id"])
    )
    assert discovered == 1
    poll_events = [
        row
        for row in (
            test_db.query(ProjectIncomingEvent)
            .filter(ProjectIncomingEvent.parent_id == hook["id"])
            .all()
        )
        if row.metadata_json.get("collection_mode") == "poll"
    ]
    assert len(poll_events) == 1
    poll_event = poll_events[0]
    asyncio.run(
        project_incoming_hook_service.process_event(test_db, str(poll_event.id))
    )
    assert test_db.query(ProjectAutomationRun).count() == 1
    assert test_db.query(LoopItem).count() == 1


def test_list_survives_legacy_incoming_subscription(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    """A legacy external-intake hook (source='incoming') must not 500 the list."""
    project = _project(test_client, test_token)
    legacy = ProjectIncomingHook(
        public_id="legacy-incoming-hook",
        cloud_project_id=str(project["id"]),
        name="旧外部系统",
        source="incoming",
        status="active",
        metadata_json={},
    )
    test_db.add(legacy)
    test_db.commit()

    response = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
    )
    assert response.status_code == 200
    payload = response.json()
    assert len(payload) == 1
    assert payload[0]["sourceType"] == "generic"
    assert payload[0]["resource"]["resourceType"] == "endpoint"
