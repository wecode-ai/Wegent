# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API coverage for project event subscriptions."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import (
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRun,
    ProjectIncomingEvent,
    ProjectIncomingHook,
    loop_datetime_value_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.services import runtime_work_service
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
    *,
    delivery_id: str,
) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-GitHub-Event": "check_run",
        "X-GitHub-Delivery": delivery_id,
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
    assert "webhookSecret" not in hook

    payload = _failed_check_payload()
    body = json.dumps(payload, separators=(",", ":"))
    first = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(delivery_id="delivery-1"),
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
        headers=_github_headers(delivery_id="delivery-1"),
        content=body,
    )
    assert duplicate.status_code == 202
    assert duplicate.json()["status"] == "duplicate"
    assert duplicate.json()["eventId"] == first.json()["eventId"]
    assert test_db.query(ProjectIncomingEvent).count() == 1


def test_subscription_accepts_delivery_without_signature(
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
            "X-GitHub-Delivery": "delivery-unsigned",
        },
        json=_failed_check_payload(),
    )

    assert response.status_code == 202
    assert test_db.query(ProjectIncomingEvent).count() == 1


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
        headers=_github_headers(delivery_id="delivery-rule-match"),
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
    assert "webhookSecret" not in rotated.json()
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


def test_delete_subscription_removes_it_and_invalidates_webhook(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))

    response = test_client.delete(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks/{hook['id']}",
        headers=_auth(test_token),
    )

    assert response.status_code == 204
    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
    )
    assert listed.status_code == 200
    assert listed.json() == []
    assert test_client.post(str(hook["webhookUrl"]), json={}).status_code == 404
    stored = test_db.get(ProjectIncomingHook, hook["id"])
    assert stored is not None
    assert stored.status == "disabled"
    assert not loop_datetime_value_is_unset(stored.deleted_at)


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


def test_public_api_cannot_select_machine_cli_credentials(
    test_client: TestClient,
    test_token: str,
) -> None:
    project = _project(test_client, test_token)

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/incoming-hooks",
        headers=_auth(test_token),
        json={
            "name": "Machine CLI polling",
            "source_type": "github",
            "collection_mode": "poll",
            "credential_ref": "machine-cli",
            "resource": {
                "resource_type": "repository",
                "url": "https://example.invalid/acme/app",
            },
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Machine CLI credentials are reserved for branch collectors"
    )


def test_poll_subscription_can_switch_to_hybrid_and_exposes_webhook_address(
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
    assert "webhookSecret" not in created.json()

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
    assert "webhookSecret" not in updated.json()

    payload = _failed_check_payload()
    delivery = test_client.post(
        str(updated.json()["webhookUrl"]),
        headers=_github_headers(delivery_id="delivery-after-upgrade"),
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
        headers=_github_headers(delivery_id="hybrid-delivery"),
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


def test_webhook_continue_binding_succeeds_with_preexisting_binding(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A continue_binding rule succeeds immediately when the change request is
    already bound to an active task when the webhook event arrives."""

    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))

    item = LoopItem(
        cloud_project_id=str(project["id"]),
        title="Bound implementation task",
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.flush()
    binding = LoopItemTaskBinding(
        cloud_project_id=str(project["id"]),
        loop_item_id=item.id,
        task_user_id=test_user.id,
        device_id="desktop-1",
        task_id="runtime-task-1",
        task_title="Bound implementation task",
        linked_by_user_id=test_user.id,
        metadata_json={
            "change_requests": [
                {
                    "provider": "github",
                    "instance_url": "https://github.example",
                    "repository": "acme/app",
                    "number": 7,
                    "url": "https://github.example/acme/app/pull/7",
                    "head_branch": "fix/checks",
                    "base_branch": "main",
                    "head_commit": "abc1234",
                    "source": "delivery",
                    "bound_at": "2026-08-01T00:00:00",
                    "last_confirmed_at": "2026-08-01T00:00:00",
                }
            ]
        },
    )
    test_db.add(binding)
    test_db.commit()

    rule_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Resume bound task",
            "prompt": "Fix the failing checks in the bound task.",
            "triggerType": "event",
            "eventType": "change_request.checks_failed",
            "eventConfig": {
                "subscription_id": hook["id"],
                "execution_target": "continue_binding",
                "target_branches": ["main"],
            },
            "assignmentMode": "manual",
            "roleSource": "generic",
            "runtimeSource": "runtime_user",
            "runtimeUserId": test_user.id,
        },
    )
    assert rule_response.status_code == 201, rule_response.text

    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        AsyncMock(),
    )
    send_runtime_message = AsyncMock(
        return_value=SimpleNamespace(accepted=True, error=None)
    )
    monkeypatch.setattr(
        runtime_work_service,
        "send_runtime_message",
        send_runtime_message,
    )

    payload = _failed_check_payload()
    body = json.dumps(payload, separators=(",", ":"))
    response = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(delivery_id="delivery-continue"),
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
    test_db.refresh(run)
    assert run.status == "succeeded"
    assert run.task_id == str(item.id)
    send_runtime_message.assert_awaited_once()


def test_webhook_continue_binding_preserves_bound_task_model(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A continue_binding run sends the bound task's model with the message."""

    project = _project(test_client, test_token)
    hook = _github_subscription(test_client, test_token, str(project["id"]))

    item = LoopItem(
        cloud_project_id=str(project["id"]),
        title="Bound implementation task",
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add(item)
    test_db.flush()
    binding = LoopItemTaskBinding(
        cloud_project_id=str(project["id"]),
        loop_item_id=item.id,
        task_user_id=test_user.id,
        device_id="desktop-1",
        task_id="runtime-task-1",
        task_title="Bound implementation task",
        linked_by_user_id=test_user.id,
        metadata_json={
            "change_requests": [
                {
                    "provider": "github",
                    "instance_url": "https://github.example",
                    "repository": "acme/app",
                    "number": 7,
                    "url": "https://github.example/acme/app/pull/7",
                    "head_branch": "fix/checks",
                    "base_branch": "main",
                    "head_commit": "abc1234",
                    "source": "delivery",
                    "bound_at": "2026-08-01T00:00:00",
                    "last_confirmed_at": "2026-08-01T00:00:00",
                }
            ]
        },
    )
    test_db.add(binding)
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project["id"]),
        status="completed",
        execution_device_id="desktop-1",
        runtime_device_id="desktop-1",
        runtime_task_id="runtime-task-1",
        assigner_user_id=test_user.id,
        executor_owner_user_id=test_user.id,
        execution_payload=json.dumps(
            {
                "runtime_selection": {
                    "model": "dpskv4f",
                    "model_type": "user",
                    "model_options": {"protocol": "openai-responses"},
                }
            }
        ),
    )
    test_db.add(execution)
    test_db.commit()

    rule_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Resume bound task with model",
            "prompt": "Fix the failing checks in the bound task.",
            "triggerType": "event",
            "eventType": "change_request.checks_failed",
            "eventConfig": {
                "subscription_id": hook["id"],
                "execution_target": "continue_binding",
                "target_branches": ["main"],
            },
            "assignmentMode": "manual",
            "roleSource": "generic",
            "runtimeSource": "runtime_user",
            "runtimeUserId": test_user.id,
        },
    )
    assert rule_response.status_code == 201, rule_response.text

    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        AsyncMock(),
    )
    send_runtime_message = AsyncMock(
        return_value=SimpleNamespace(accepted=True, error=None)
    )
    monkeypatch.setattr(
        runtime_work_service,
        "send_runtime_message",
        send_runtime_message,
    )

    payload = _failed_check_payload()
    body = json.dumps(payload, separators=(",", ":"))
    response = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_headers(delivery_id="delivery-continue-model"),
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
    test_db.refresh(run)
    assert run.status == "succeeded"
    send_runtime_message.assert_awaited_once()
    sent_request = send_runtime_message.await_args.kwargs["request"]
    assert sent_request.model_selection is not None
    assert sent_request.model_selection.model_name == "dpskv4f"
    assert sent_request.model_selection.model_type == "user"


def test_poll_only_subscription_matches_rule_and_dispatches_one_run(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A poll-only subscription flows a fetched event all the way through rule
    matching to a dispatched automation run."""

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

    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        AsyncMock(),
    )

    class FakePoller:
        async def fetch_page(self, *, resource, credential, cursor):
            assert resource["path"] == "acme/app"
            assert credential == "github-token"
            return PollPage(
                inputs=(
                    PolledInput(
                        identity="check_run:7:failure:abc1234",
                        title="github: check_run #7",
                        payload={
                            "action": "completed",
                            "check_run": {
                                "id": 7,
                                "status": "completed",
                                "conclusion": "failure",
                                "head_sha": "abc1234",
                                "pull_requests": [
                                    {
                                        "number": 7,
                                        "html_url": (
                                            "https://github.example/acme/app/pull/7"
                                        ),
                                        "head": {
                                            "ref": "fix/checks",
                                            "sha": "abc1234",
                                        },
                                        "base": {"ref": "main"},
                                    }
                                ],
                            },
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

    run = test_db.query(ProjectAutomationRun).one()
    test_db.refresh(run)
    assert run.status == "pending"
    assert run.task_id
    assert test_db.get(LoopItem, run.task_id) is not None
    dispatch.assert_awaited_once()


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
