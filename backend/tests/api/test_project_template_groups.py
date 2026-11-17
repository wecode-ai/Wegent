# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Template group contracts with existing humans and real permission checks."""

import json
import logging
import uuid
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.endpoints import project_automations
from app.db import session as database_session
from app.models.kind import Kind
from app.models.user import User
from app.schemas.workspace import CollaborationGroupCreate, CollaborationGroupResponse
from app.services.workspaces.collaboration_groups import _group_payload
from shared.telemetry import decorators

TemplateProject = tuple[str, dict[str, str], dict[str, Any]]
PRIVATE_RESPONSE_VALUE = "private-template-response-value"


@pytest.fixture
def template_spans(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer(__name__)
    monkeypatch.setattr(decorators, "_is_telemetry_enabled", lambda: True)
    monkeypatch.setattr(decorators, "_get_tracer", lambda _: tracer)
    try:
        yield exporter
    finally:
        provider.shutdown()


def _human_template_payload(humans: list[User]) -> dict[str, Any]:
    path = (
        Path(__file__).resolve().parents[3] / "shared/data/collaboration-templates.json"
    )
    template = next(
        item
        for item in json.loads(path.read_text(encoding="utf-8"))
        if item["metadata"]["name"] == "product-lifecycle"
    )
    group = template["spec"]["resources"]["collaboration"]["groups"][0]
    roles = {
        role["key"]: {
            "kind": "human",
            "id": str(human.id),
            "name": human.user_name,
            "responsibility": role["responsibility"],
        }
        for role, human in zip(group["roles"], humans, strict=True)
    }
    return {
        "name": group["name"],
        "description": group["description"],
        "instructions": group["instructions"],
        "leader": roles[group["leaderRole"]],
        "members": list(roles.values()),
        "stages": [
            {
                "id": stage["key"],
                "name": stage["name"],
                "assignee": roles[stage["ownerRole"]],
            }
            for stage in group["stages"]
        ],
    }


@pytest.fixture
def human_template_project(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> TemplateProject:
    headers = {"Authorization": f"Bearer {test_token}"}
    workspace = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "Template contracts"}
    )
    assert workspace.status_code == 201
    project = test_client.post(
        f"/api/v1/workspaces/{workspace.json()['id']}/projects",
        headers=headers,
        json={"name": "Existing human template"},
    )
    assert project.status_code == 201
    project_url = f"/api/v1/cloud-projects/{project.json()['id']}"
    humans = [test_user]
    for _ in range(5):
        name = f"template-human-{uuid.uuid4().hex[:10]}"
        human = User(
            user_name=name,
            email=f"{name}@example.com",
            password_hash="unused",
            is_active=True,
        )
        test_db.add(human)
        test_db.commit()
        test_db.refresh(human)
        added = test_client.post(
            f"{project_url}/members",
            headers=headers,
            json={"user_id": human.id, "role": "Developer"},
        )
        assert added.status_code == 201
        humans.append(human)
    return project_url, headers, _human_template_payload(humans)


def test_six_existing_humans_create_once_and_duplicate_returns_conflict(
    test_client: TestClient,
    human_template_project: TemplateProject,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project_url, headers, payload = human_template_project
    caplog.set_level(logging.INFO, logger=project_automations.__name__)

    created = test_client.post(
        f"{project_url}/collaboration-groups", headers=headers, json=payload
    )
    duplicate = test_client.post(
        f"{project_url}/collaboration-groups", headers=headers, json=payload
    )

    assert created.status_code == 201
    assert created.json()["members"] == payload["members"]
    assert len(created.json()["stages"]) == 6
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == (
        "Collaboration group name already exists in this owner scope"
    )
    groups = test_client.get(
        f"{project_url}/collaboration-groups", headers=headers
    ).json()["items"]
    assert [group["id"] for group in groups] == [created.json()["id"]]
    assert "stage=create status=409 error_type=HTTPException" in caplog.text
    assert payload["name"] not in caplog.text


def test_human_with_revoked_developer_access_returns_configuration_error(
    test_client: TestClient,
    human_template_project: TemplateProject,
    caplog: pytest.LogCaptureFixture,
) -> None:
    project_url, headers, payload = human_template_project
    human_id = payload["members"][-1]["id"]
    changed = test_client.patch(
        f"{project_url}/members/{human_id}",
        headers=headers,
        json={"role": "Viewer"},
    )
    assert changed.status_code == 200

    response = test_client.post(
        f"{project_url}/collaboration-groups", headers=headers, json=payload
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Human is not available in this Project"
    groups = test_client.get(
        f"{project_url}/collaboration-groups", headers=headers
    ).json()["items"]
    assert groups == []
    assert "stage=create status=422 error_type=HTTPException" in caplog.text


def test_response_validation_hides_input_values() -> None:
    with pytest.raises(ValidationError) as captured:
        CollaborationGroupResponse.model_validate(
            {"coordination_mode": PRIVATE_RESPONSE_VALUE}
        )

    for message in (str(captured.value), repr(captured.value)):
        assert "coordination_mode" in message
        assert "literal_error" in message
        assert PRIVATE_RESPONSE_VALUE not in message


def test_group_storage_failure_hides_bound_instructions_from_error_and_trace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    template_spans: InMemorySpanExporter,
) -> None:
    monkeypatch.setattr(
        database_session,
        "SQLALCHEMY_DATABASE_URL",
        f"sqlite:///{tmp_path / 'group-storage.sqlite3'}",
    )
    engine = database_session._create_engine()
    private_instructions = "P6719"
    human = {"kind": "human", "id": "1", "name": "synthetic"}
    payload = _group_payload(
        CollaborationGroupCreate(
            name="g",
            instructions=private_instructions,
            leader=human,
            members=[human],
        )
    )

    @decorators.trace_sync("project.collaboration_group.create")
    def insert_group(group_id: int | None = None) -> int:
        with Session(engine) as db:
            group = Kind(
                id=group_id,
                user_id=1,
                kind="CollaborationGroup",
                name="g",
                namespace="projects/1",
                json=payload,
            )
            db.add(group)
            db.flush()
            created_id = int(group.id)
            db.commit()
            return created_id

    try:
        Kind.__table__.create(engine)
        group_id = insert_group()
        with Session(engine) as db:
            stored = db.get(Kind, group_id)
            assert stored.json == payload
            assert stored.json["spec"]["instructions"] == private_instructions

        with pytest.raises(IntegrityError) as captured:
            insert_group(group_id)

        assert "INSERT INTO kinds" in captured.value.statement
        assert private_instructions in str(captured.value.params)
        assert "UNIQUE constraint failed: kinds.id" in str(captured.value)
        span = next(
            span
            for span in template_spans.get_finished_spans()
            if span.status.status_code == StatusCode.ERROR
        )
        exceptions = [event for event in span.events if event.name == "exception"]
        assert exceptions
        assert all(
            "IntegrityError" in event.attributes["exception.type"]
            for event in exceptions
        )
        trace_text = str(span.status.description) + str(
            [dict(event.attributes) for event in exceptions]
        )
        assert "INSERT INTO kinds" in trace_text
        messages = {
            "error": str(captured.value),
            "error_repr": repr(captured.value),
            "span_status": str(span.status.description),
            "span_exceptions": str([dict(event.attributes) for event in exceptions]),
        }
        assert [
            name for name, text in messages.items() if private_instructions in text
        ] == []
    finally:
        engine.dispose()


def test_response_failure_reports_created_group_without_logging_payload(
    test_client: TestClient,
    human_template_project: TemplateProject,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    template_spans: InMemorySpanExporter,
) -> None:
    project_url, headers, payload = human_template_project
    create = project_automations.workspace_service.create_project_collaboration_group

    def create_with_invalid_response(*args: Any, **kwargs: Any) -> dict[str, object]:
        result = create(*args, **kwargs)
        # Inject failure after the real transaction commits.
        return {**result, "coordination_mode": PRIVATE_RESPONSE_VALUE}

    monkeypatch.setattr(
        project_automations.workspace_service,
        "create_project_collaboration_group",
        create_with_invalid_response,
    )
    client = TestClient(test_client.app, raise_server_exceptions=False)
    try:
        response = client.post(
            f"{project_url}/collaboration-groups", headers=headers, json=payload
        )
    finally:
        client.close()

    assert response.status_code == 500
    groups = test_client.get(
        f"{project_url}/collaboration-groups", headers=headers
    ).json()["items"]
    assert len(groups) == 1
    records = [
        record.getMessage()
        for record in caplog.records
        if record.name == project_automations.__name__
    ]
    assert any(
        f"group_id={groups[0]['id']} stage=response status=500 "
        "error_type=ValidationError" in message
        for message in records
    )
    assert all(payload["name"] not in message for message in records)
    assert all(payload["instructions"] not in message for message in records)
    span = next(
        span
        for span in template_spans.get_finished_spans()
        if span.name == "project.collaboration_group.create"
    )
    assert span.status.status_code == StatusCode.ERROR
    assert "coordination_mode" in span.status.description
    exceptions = [event for event in span.events if event.name == "exception"]
    assert exceptions
    assert all(
        "ValidationError" in event.attributes["exception.type"] for event in exceptions
    )
    trace_text = str(span.status.description) + str(
        [dict(event.attributes) for event in exceptions]
    )
    for private_value in (
        PRIVATE_RESPONSE_VALUE,
        payload["name"],
        payload["instructions"],
    ):
        assert private_value not in trace_text
        assert private_value not in caplog.text
