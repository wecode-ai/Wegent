# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Real SQLite resource transactions for durable template write receipts."""

import json
import logging
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.endpoints import cloud_projects, project_automations
from app.core.security import create_access_token
from app.models.cloud_project import CloudProject
from app.models.delivery import ProjectChatAgent
from app.models.template_import import TemplateImportOperation, TemplateImportReceipt
from app.models.user import User
from app.services.project_automations import project_automation_service
from app.services.project_chat.service import project_chat_service
from app.services.template_imports import TemplateImportWrite
from tests.api.test_project_template_groups import human_template_project  # noqa: F401
from tests.api.test_project_template_groups import (
    TemplateProject,
)

logger = logging.getLogger(__name__)


@pytest.fixture
def import_request(
    request: pytest.FixtureRequest,
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    human_template_project: TemplateProject,
) -> tuple[str, str, dict[str, str], dict[str, Any], str]:
    kind = request.param
    project_url, headers, group = human_template_project
    operation = TemplateImportOperation(
        id=uuid.uuid4().hex,
        project_id=project_url.rsplit("/", 1)[1],
        actor_user_id=test_user.id,
        protocol_version=1,
        intent_sha256=uuid.uuid4().hex.ljust(64, "0"),
        intent_encrypted="synthetic-encrypted-intent",
        manifest=[{"key": f"{kind}:test", "kind": kind}],
    )
    test_db.add(operation)
    test_db.commit()
    headers = {
        **headers,
        "X-Template-Import-Id": operation.id,
        "X-Template-Import-Step": f"{kind}:test",
    }
    if kind == "group":
        return "post", f"{project_url}/collaboration-groups", headers, group, kind
    if kind == "agent":
        return (
            "post",
            f"{project_url}/chat-agents",
            headers,
            {
                "name": "Imported reviewer",
                "runtime": "codex",
                "systemPrompt": "Review the implementation.",
                "mcpServers": {"synthetic": {"command": "synthetic-command"}},
            },
            kind,
        )
    if kind == "automation":
        return (
            "post",
            f"{project_url}/automations",
            headers,
            {
                "name": "Imported assignment",
                "prompt": "Coordinate delivery.",
                "triggerType": "event",
                "eventType": "task.created",
                "eventConfig": {},
                "targetKind": "human",
                "targetId": str(test_user.id),
                "enabled": False,
            },
            kind,
        )
    project = test_db.get(CloudProject, operation.project_id)
    return (
        "patch",
        project_url,
        headers,
        {
            "version": project.version,
            "tags": ["Imported stage"],
        },
        kind,
    )


@pytest.mark.parametrize(
    "import_request", ["agent", "group", "automation", "board"], indirect=True
)
def test_same_step_replays_and_mismatched_payload_is_rejected(
    test_client: TestClient,
    test_db: Session,
    import_request,
) -> None:
    method, url, headers, payload, kind = import_request
    created = test_client.request(method, url, headers=headers, json=payload)
    assert created.status_code in {200, 201}, created.text
    replay = test_client.request(method, url, headers=headers, json=payload)
    assert replay.status_code == created.status_code, replay.text
    assert replay.json()["id"] == created.json()["id"]
    receipt = (
        test_db.query(TemplateImportReceipt)
        .filter_by(
            operation_id=headers["X-Template-Import-Id"],
        )
        .one()
    )
    assert receipt.resource_id == str(created.json()["id"])
    changed = {
        **payload,
        ("tags" if kind == "board" else "name"): (
            ["Changed"] if kind == "board" else "Changed"
        ),
    }
    rejected = test_client.request(method, url, headers=headers, json=changed)
    if kind == "board":
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["tags"] == ["Imported stage"]
    else:
        assert rejected.status_code == 409
        assert "another request" in rejected.json()["detail"]
    assert (
        test_db.query(TemplateImportReceipt)
        .filter_by(operation_id=receipt.operation_id)
        .count()
        == 1
    )


@pytest.mark.parametrize(
    "import_request", ["agent", "group", "automation", "board"], indirect=True
)
def test_receipt_survives_post_commit_response_failure(
    test_client: TestClient,
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    import_request,
) -> None:
    method, url, headers, payload, kind = import_request
    target, attribute = {
        "agent": (project_chat_service, "agent_to_view"),
        "group": (project_automations.CollaborationGroupResponse, "model_validate"),
        "automation": (project_automation_service, "_rule_view"),
        "board": (cloud_projects, "_project_response"),
    }[kind]
    original = getattr(target, attribute)

    def fail_response(*_args, **_kwargs):
        raise HTTPException(500, "Synthetic post-commit response failure")

    monkeypatch.setattr(target, attribute, fail_response)
    failed = test_client.request(method, url, headers=headers, json=payload)
    assert failed.status_code == 500, failed.text
    receipt = (
        test_db.query(TemplateImportReceipt)
        .filter_by(
            operation_id=headers["X-Template-Import-Id"],
        )
        .one()
    )
    resource_id = receipt.resource_id
    monkeypatch.setattr(target, attribute, original)
    replay = test_client.request(method, url, headers=headers, json=payload)
    assert replay.status_code in {200, 201}, replay.text
    assert str(replay.json()["id"]) == resource_id


def _resource_state(
    client: TestClient, db: Session, url: str, headers: dict[str, str], kind: str
) -> dict[str, Any] | set[str]:
    if kind == "board":
        project = (
            db.query(CloudProject)
            .filter_by(id=int(url.rsplit("/", 1)[1]))
            .populate_existing()
            .one()
        )
        return {
            "version": project.version,
            "tags": project.tags,
            "board_views": (project.metadata_json or {}).get("board_views"),
        }
    response = client.get(url, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    rows = body["items"] if isinstance(body, dict) else body
    return {str(row["id"]) for row in rows}


@pytest.mark.parametrize(
    "import_request", ["agent", "group", "automation", "board"], indirect=True
)
def test_resource_and_receipt_roll_back_together(
    test_client: TestClient,
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    import_request,
) -> None:
    method, url, headers, payload, kind = import_request
    baseline = _resource_state(test_client, test_db, url, headers, kind)
    original = TemplateImportWrite.record

    def fail_before_commit(self, resource_id):
        original(self, resource_id)
        raise HTTPException(500, "Synthetic failure before resource commit")

    monkeypatch.setattr(TemplateImportWrite, "record", fail_before_commit)
    failed = test_client.request(method, url, headers=headers, json=payload)
    assert failed.status_code == 500, failed.text
    assert _resource_state(test_client, test_db, url, headers, kind) == baseline
    assert (
        test_db.query(TemplateImportReceipt)
        .filter_by(
            operation_id=headers["X-Template-Import-Id"],
        )
        .count()
        == 0
    )
    monkeypatch.setattr(TemplateImportWrite, "record", original)
    created = test_client.request(method, url, headers=headers, json=payload)
    assert created.status_code in {200, 201}, created.text
    expected = (
        {**baseline, "version": baseline["version"] + 1, "tags": payload["tags"]}
        if kind == "board"
        else baseline | {str(created.json()["id"])}
    )
    assert _resource_state(test_client, test_db, url, headers, kind) == expected
    assert (
        test_db.query(TemplateImportReceipt)
        .filter_by(
            operation_id=headers["X-Template-Import-Id"],
        )
        .count()
        == 1
    )


@pytest.mark.parametrize("import_request", ["board"], indirect=True)
def test_board_replay_returns_current_project_without_overwriting_later_edits(
    test_client: TestClient,
    import_request,
) -> None:
    method, url, headers, payload, _ = import_request
    created = test_client.request(method, url, headers=headers, json=payload)
    assert created.status_code == 200, created.text
    edited = test_client.patch(
        url,
        headers={"Authorization": headers["Authorization"]},
        json={
            "version": created.json()["version"],
            "tags": ["Human edit"],
        },
    )
    assert edited.status_code == 200, edited.text
    replay = test_client.request(
        method,
        url,
        headers=headers,
        json={
            **payload,
            "version": edited.json()["version"],
            "tags": [*edited.json()["tags"], *payload["tags"]],
        },
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["tags"] == ["Human edit"]
    assert replay.json()["version"] == edited.json()["version"]


@pytest.mark.parametrize("import_request", ["group"], indirect=True)
def test_operation_scope_and_manifest_are_enforced(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    import_request,
) -> None:
    method, url, headers, payload, _ = import_request
    wrong_step = test_client.request(
        method,
        url,
        headers={
            **headers,
            "X-Template-Import-Step": "agent:test",
        },
        json=payload,
    )
    assert wrong_step.status_code == 409
    operation = test_db.get(TemplateImportOperation, headers["X-Template-Import-Id"])
    operation.actor_user_id = test_user.id + 99999
    test_db.commit()
    wrong_actor = test_client.request(method, url, headers=headers, json=payload)
    assert wrong_actor.status_code == 404
    assert (
        test_db.query(TemplateImportReceipt)
        .filter_by(operation_id=operation.id)
        .count()
        == 0
    )


@pytest.mark.parametrize(
    "import_request", ["agent", "group", "automation", "board"], indirect=True
)
def test_replay_rechecks_current_maintainer_permission(
    test_client: TestClient,
    test_db: Session,
    human_template_project: TemplateProject,
    import_request,
) -> None:
    method, url, headers, payload, _ = import_request
    project_url, owner_headers, group = human_template_project
    user_id = int(group["members"][1]["id"])
    member = test_db.get(User, user_id)
    granted = test_client.patch(
        f"{project_url}/members/{user_id}",
        headers=owner_headers,
        json={"role": "Maintainer"},
    )
    assert granted.status_code == 200, granted.text
    operation = test_db.get(TemplateImportOperation, headers["X-Template-Import-Id"])
    operation.actor_user_id = user_id
    test_db.commit()
    headers = {
        **headers,
        "Authorization": "Bearer "
        + create_access_token(data={"sub": member.user_name}),
    }
    created = test_client.request(method, url, headers=headers, json=payload)
    assert created.status_code in {200, 201}, created.text
    revoked = test_client.patch(
        f"{project_url}/members/{user_id}",
        headers=owner_headers,
        json={"role": "Viewer"},
    )
    assert revoked.status_code == 200, revoked.text
    replay = test_client.request(method, url, headers=headers, json=payload)
    assert replay.status_code == 403, replay.text


@pytest.mark.parametrize(
    "import_request", ["agent", "group", "automation", "board"], indirect=True
)
def test_import_headers_must_be_supplied_together(
    test_client: TestClient,
    import_request,
) -> None:
    method, url, headers, payload, _ = import_request
    headers = {
        key: value for key, value in headers.items() if key != "X-Template-Import-Step"
    }
    response = test_client.request(method, url, headers=headers, json=payload)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("import_request", ["group"], indirect=True)
def test_operation_cannot_write_into_another_project(
    test_client: TestClient,
    test_db: Session,
    import_request,
) -> None:
    method, url, headers, payload, _ = import_request
    operation = test_db.get(TemplateImportOperation, headers["X-Template-Import-Id"])
    operation.project_id = "another-project"
    test_db.commit()
    response = test_client.request(method, url, headers=headers, json=payload)
    assert response.status_code == 404, response.text


def _product_lifecycle_agents() -> list[dict[str, Any]]:
    path = (
        Path(__file__).resolve().parents[3] / "shared/data/collaboration-templates.json"
    )
    template = next(
        item
        for item in json.loads(path.read_text(encoding="utf-8"))
        if item["metadata"]["name"] == "product-lifecycle"
    )
    return template["spec"]["resources"]["collaboration"]["agents"]


def _deliver_template_agent(
    client: TestClient,
    url: str,
    auth: dict[str, str],
    agent: dict[str, Any],
    operation_id: str | None,
    phase: str,
) -> str:
    headers = dict(auth)
    if operation_id is not None:
        headers.update(
            {
                "X-Template-Import-Id": operation_id,
                "X-Template-Import-Step": f"agent:{agent['key']}",
            }
        )
    payload = {key: value for key, value in agent.items() if key != "key"}
    response = client.post(url, headers=headers, json=payload)
    assert response.status_code == 201, response.text
    resource_id = str(response.json()["id"])
    logger.info(
        "MAN03 ordered-delivery phase=%s status=%s resource_id=%s",
        phase,
        response.status_code,
        resource_id,
    )
    return resource_id


@pytest.mark.parametrize(
    ("durable_receipts", "expected_total", "expected_leaders"),
    [(False, 7, 2), (True, 6, 1)],
    ids=["legacy-no-receipt-seven-agents", "durable-receipt-six-agents"],
)
def test_man03_retry_arrives_before_delayed_original_creates_one_agent_per_role(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    human_template_project: TemplateProject,
    caplog: pytest.LogCaptureFixture,
    durable_receipts: bool,
    expected_total: int,
    expected_leaders: int,
) -> None:
    """Reproduce QA's server arrival order, without simulating Electron timing."""
    project_url, auth, _group = human_template_project
    project_id = project_url.rsplit("/", 1)[1]
    agents = _product_lifecycle_agents()
    assert len(agents) == 6
    assert agents[0]["name"] == "项目负责人"
    assert all(agent["runtime"] == "codex" for agent in agents)
    operation_id = uuid.uuid4().hex if durable_receipts else None
    if operation_id is not None:
        test_db.add(
            TemplateImportOperation(
                id=operation_id,
                project_id=project_id,
                actor_user_id=test_user.id,
                protocol_version=1,
                intent_sha256=uuid.uuid4().hex.ljust(64, "0"),
                intent_encrypted="synthetic-encrypted-intent",
                manifest=[
                    {"key": f"agent:{agent['key']}", "kind": "agent"}
                    for agent in agents
                ],
            )
        )
        test_db.commit()
    caplog.set_level(logging.INFO, logger=__name__)
    retry_client = TestClient(test_client.app)
    url = f"{project_url}/chat-agents"
    try:
        retried_id = _deliver_template_agent(
            retry_client,
            url,
            auth,
            agents[0],
            operation_id,
            "retry-before-original",
        )
        for agent in agents[1:]:
            _deliver_template_agent(
                retry_client,
                url,
                auth,
                agent,
                operation_id,
                "remaining-role",
            )
        delayed_id = _deliver_template_agent(
            test_client,
            url,
            auth,
            agents[0],
            operation_id,
            "delayed-original",
        )
    finally:
        retry_client.close()
    persisted = (
        test_db.query(ProjectChatAgent).filter_by(cloud_project_id=project_id).all()
    )
    names = Counter(agent.name for agent in persisted)
    assert len(persisted) == expected_total
    assert names["项目负责人"] == expected_leaders
    assert all(names[agent["name"]] == 1 for agent in agents[1:])
    assert (retried_id == delayed_id) is durable_receipts
    receipt_count = (
        test_db.query(TemplateImportReceipt)
        .filter_by(operation_id=operation_id)
        .count()
    )
    assert receipt_count == (6 if durable_receipts else 0)
    logger.info(
        "MAN03 ordered-delivery durable=%s total_agents=%s leader_agents=%s "
        "retry_id=%s delayed_id=%s",
        durable_receipts,
        len(persisted),
        names["项目负责人"],
        retried_id,
        delayed_id,
    )
