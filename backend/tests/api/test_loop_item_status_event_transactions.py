# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""HTTP status changes and their selected automation event commit together."""

import asyncio
from dataclasses import dataclass
from datetime import timedelta
from typing import Iterator
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import get_db
from app.core.security import create_access_token, get_password_hash
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
    ProjectIncomingEvent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.workspace import CollaborationGroupCreate
from app.services.project_automation_domain import ProjectAutomationEvent, utcnow
from app.services.project_automation_execution import project_automation_execution
from app.services.project_incoming_hooks import project_incoming_hook_service
from app.services.workspaces import workspace_service
from tests.utils.collaboration import (
    authorize_project,
    authorize_project_agent,
    authorize_resource,
)


@dataclass(frozen=True)
class StatusAutomationApi:
    client: TestClient
    sessions: sessionmaker[Session]
    headers: dict[str, str]
    project_id: str
    user_id: int


@pytest.fixture
def status_api(
    mcp_test_db: Session,
    test_app: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[StatusAutomationApi]:
    user = User(
        user_name="status-transaction-user",
        password_hash=get_password_hash("test-password"),
        email="status-transaction@example.com",
        is_active=True,
    )
    mcp_test_db.add(user)
    mcp_test_db.flush()
    project = CloudProject(
        project_key="STATUS-TX",
        name="Atomic status events",
        created_by_user_id=user.id,
        storage_prefix="projects/status-transactions",
    )
    authorize_project(mcp_test_db, project)
    mcp_test_db.add(project)
    mcp_test_db.commit()
    sessions = sessionmaker(mcp_test_db.get_bind(), expire_on_commit=False)

    def request_db() -> Iterator[Session]:
        with sessions() as db:
            yield db

    previous_overrides = test_app.dependency_overrides.copy()
    test_app.dependency_overrides[get_db] = request_db
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )
    monkeypatch.setattr(
        "app.services.wework_notifications.deliver_notification", AsyncMock()
    )
    client = TestClient(test_app, raise_server_exceptions=False)
    try:
        yield StatusAutomationApi(
            client=client,
            sessions=sessions,
            headers={
                "Authorization": "Bearer "
                + create_access_token(data={"sub": user.user_name})
            },
            project_id=str(project.id),
            user_id=user.id,
        )
    finally:
        client.close()
        test_app.dependency_overrides.clear()
        test_app.dependency_overrides.update(previous_overrides)


def _issue_and_rules(api: StatusAutomationApi) -> tuple[dict, list[str]]:
    created = api.client.post(
        f"/api/v1/cloud-projects/{api.project_id}/loop-items",
        headers=api.headers,
        json={
            "title": "Persist review transition",
            "description": "Keep the original event context",
            "status": "in_progress",
        },
    )
    assert created.status_code == 201, created.text
    rule_ids = []
    for name in ["First reviewer", "Selected reviewer"]:
        rule = api.client.post(
            f"/api/v1/cloud-projects/{api.project_id}/automations",
            headers=api.headers,
            json={
                "name": name,
                "prompt": "Review the Issue after it enters review.",
                "triggerType": "event",
                "eventType": "task.status_changed",
                "eventConfig": {
                    "transition": "any",
                    "statuses": ["in_review"],
                    "execution_target": "existing_issue",
                },
                "targetKind": "human",
                "targetId": str(api.user_id),
            },
        )
        assert rule.status_code == 201, rule.text
        rule_ids.append(rule.json()["id"])
    return created.json(), rule_ids


def _assignment(api: StatusAutomationApi, target_kind: str) -> dict[str, str]:
    with api.sessions() as db:
        project = db.get(CloudProject, api.project_id)
        if target_kind == "group":
            member = {"kind": "human", "id": str(api.user_id)}
            group = workspace_service.create_project_collaboration_group(
                db,
                int(api.project_id),
                api.user_id,
                CollaborationGroupCreate(
                    name="Explicit status group", leader=member, members=[member]
                ),
            )
            return {"assignee_group_id": str(group["id"])}
        device = Kind(
            kind="Device",
            name="explicit-status-device",
            namespace="default",
            user_id=api.user_id,
            is_active=True,
            json={"spec": {"deviceType": "local"}},
        )
        db.add(device)
        db.flush()
        authorize_resource(db, project, device)
        agent = ProjectChatAgent(
            cloud_project_id=api.project_id,
            title="Explicit status Agent",
            name="Explicit status Agent",
            status="active",
            created_by_user_id=api.user_id,
            device_id=device.name,
            metadata_json={"runtime": "codex", "model": "test-model"},
        )
        authorize_project_agent(db, agent)
        db.add(agent)
        db.commit()
        return {"assignee_agent_id": agent.id}


@pytest.mark.parametrize("target_kind", ["agent", "group"])
def test_explicit_status_and_assignment_preserve_the_selected_transition(
    status_api: StatusAutomationApi,
    monkeypatch: pytest.MonkeyPatch,
    target_kind: str,
) -> None:
    api = status_api
    issue, rules = _issue_and_rules(api)
    assignment = _assignment(api, target_kind)
    process = AsyncMock(return_value=0)
    monkeypatch.setattr(project_incoming_hook_service, "process_event", process)
    patch = {"version": issue["version"], "status": "in_review", **assignment}

    ambiguous = api.client.patch(
        f"/api/v1/loop-items/{issue['id']}", headers=api.headers, json=patch
    )
    assert ambiguous.status_code == 409, ambiguous.text
    assert ambiguous.json()["detail"]["code"] == "automation_selection_required"
    with api.sessions() as db:
        persisted = db.get(LoopItem, issue["id"])
        assert persisted.status == "in_progress"
        assert persisted.version == issue["version"]
        assert not persisted.assignee_agent_id
        assert persisted.metadata_json.get("collaboration_group") is None
        assert db.query(LoopItemExecution).count() == 0
        assert (
            db.query(ProjectIncomingEvent)
            .filter_by(title="task.status_changed")
            .count()
            == 0
        )
    process.assert_not_awaited()

    selected = api.client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=api.headers,
        json={**patch, "automation_rule_id": rules[1]},
    )
    assert selected.status_code == 200, selected.text
    assert selected.json()["status"] == "in_review"
    with api.sessions() as db:
        persisted = db.get(LoopItem, issue["id"])
        assert persisted.status == "in_review"
        event = (
            db.query(ProjectIncomingEvent).filter_by(title="task.status_changed").one()
        )
        assert event.metadata_json["automation_id"] == rules[1]
        assert event.metadata_json["payload"]["status"] == "in_review"
        assert event.metadata_json["payload"]["previous_status"] == "in_progress"
        process.assert_awaited_once()
        assert process.await_args.args[1] == str(event.id)


@pytest.mark.parametrize("failure_stage", ["before_claim", "dispatch"])
def test_status_event_survives_dispatch_failure_and_fresh_session_recovery(
    status_api: StatusAutomationApi,
    monkeypatch: pytest.MonkeyPatch,
    failure_stage: str,
) -> None:
    api = status_api
    issue, rules = _issue_and_rules(api)
    patch = {"version": issue["version"], "status": "in_review"}

    ambiguous = api.client.patch(
        f"/api/v1/loop-items/{issue['id']}", headers=api.headers, json=patch
    )
    assert ambiguous.status_code == 409, ambiguous.text
    assert ambiguous.json()["detail"]["code"] == "automation_selection_required"
    with api.sessions() as db:
        assert db.get(LoopItem, issue["id"]).status == "in_progress"
        assert (
            db.query(ProjectIncomingEvent)
            .filter_by(title="task.status_changed")
            .count()
            == 0
        )

    dispatch = AsyncMock(
        side_effect=(
            [RuntimeError("dispatch interrupted"), None]
            if failure_stage == "dispatch"
            else None
        )
    )
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    with monkeypatch.context() as failure:
        if failure_stage == "before_claim":
            failure.setattr(
                project_incoming_hook_service,
                "process_event",
                AsyncMock(side_effect=RuntimeError("process stopped after commit")),
            )
        response = api.client.patch(
            f"/api/v1/loop-items/{issue['id']}",
            headers=api.headers,
            json={**patch, "automation_rule_id": rules[1]},
        )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "in_review"

    with api.sessions() as db:
        persisted = db.get(LoopItem, issue["id"])
        assert persisted.status == "in_review"
        assert persisted.version == issue["version"] + 1
        event = (
            db.query(ProjectIncomingEvent).filter_by(title="task.status_changed").one()
        )
        event_id, public_id = str(event.id), event.public_id
        assert event.status == ("failed" if failure_stage == "dispatch" else "received")
        assert event.metadata_json["automation_id"] == rules[1]
        payload = event.metadata_json["payload"]
        assert payload["previous_status"] == "in_progress"
        assert payload["status"] == "in_review"
        assert payload["version"] == persisted.version
        assert payload["description"] == "Keep the original event context"
        assert payload["status_history_length"] == len(
            persisted.metadata_json["status_history"]
        )
        assert db.query(ProjectAutomationRun).count() == (failure_stage == "dispatch")
        if failure_stage == "dispatch":
            pending_run_id = str(db.query(ProjectAutomationRun).one().id)
            event.due_at = utcnow() - timedelta(seconds=1)
            db.commit()

    unchanged = api.client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=api.headers,
        json={"version": response.json()["version"], "status": "in_review"},
    )
    assert unchanged.status_code == 200, unchanged.text

    with api.sessions() as db:
        assert asyncio.run(project_incoming_hook_service.check_pending(db)) == 1
    with api.sessions() as db:
        assert asyncio.run(project_incoming_hook_service.check_pending(db)) == 0
        event = (
            db.query(ProjectIncomingEvent).filter_by(title="task.status_changed").one()
        )
        assert str(event.id) == event_id
        assert event.public_id == public_id
        assert event.status == "processed"
        run = db.query(ProjectAutomationRun).one()
        assert run.parent_id == rules[1]
        assert run.task_id == issue["id"]
        if failure_stage == "dispatch":
            assert str(run.id) == pending_run_id
    assert dispatch.await_count == (2 if failure_stage == "dispatch" else 1)
    assert len({str(call.args[2].id) for call in dispatch.await_args_list}) == 1


def test_status_event_queue_failure_rolls_back_http_state_and_version(
    status_api: StatusAutomationApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = status_api
    issue, rules = _issue_and_rules(api)

    def fail_queue(
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> None:
        assert automation_id == rules[1]
        with api.sessions() as independent:
            persisted = independent.get(LoopItem, issue["id"])
            assert persisted.status == "in_progress"
            assert persisted.version == issue["version"]
        raise RuntimeError("queue storage failed")

    enqueue = MagicMock(side_effect=fail_queue)
    monkeypatch.setattr(project_incoming_hook_service, "queue_internal", enqueue)
    response = api.client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=api.headers,
        json={
            "version": issue["version"],
            "status": "in_review",
            "automation_rule_id": rules[1],
        },
    )
    assert response.status_code == 500
    enqueue.assert_called_once()
    with api.sessions() as db:
        persisted = db.get(LoopItem, issue["id"])
        assert persisted.status == "in_progress"
        assert persisted.version == issue["version"]
        assert (
            db.query(ProjectIncomingEvent)
            .filter_by(title="task.status_changed")
            .count()
            == 0
        )
        assert db.query(ProjectAutomationRun).count() == 0
