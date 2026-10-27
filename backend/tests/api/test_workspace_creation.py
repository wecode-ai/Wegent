# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Creation returns the committed workspace without post-create database reads."""

from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.api.endpoints.workspaces import create_workspace, get_workspace
from app.models.user import User
from app.schemas.workspace import WorkspaceCreate
from app.services.workspaces import workspace_service


def test_creation_response_needs_no_post_create_queries(
    test_db: Session, test_user: User
) -> None:
    queries: list[str] = []
    create = workspace_service.create
    engine = test_db.get_bind()

    def capture_query(_conn, _cursor, statement, _parameters, _context, _many):
        queries.append(statement)

    def create_and_capture(*args, **kwargs):
        workspace = create(*args, **kwargs)
        event.listen(engine, "before_cursor_execute", capture_query)
        return workspace

    try:
        with patch.object(workspace_service, "create", side_effect=create_and_capture):
            response = create_workspace(
                WorkspaceCreate(name="Fast workspace", description="Creation snapshot"),
                test_db,
                test_user,
            )
    finally:
        event.remove(engine, "before_cursor_execute", capture_query)

    assert queries == [], f"Unexpected response queries: {queries}"
    assert response.access_role == "Owner"
    assert response.member_count == 1
    assert response.project_count == 0
    assert response.agent_count == 0
    assert response.execution_environment_count == 0
    assert response == get_workspace(int(response.id), test_db, test_user)


def test_invalid_name_can_be_corrected(
    test_client: TestClient, test_token: str
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    invalid = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "x" * 101}
    )
    assert invalid.status_code == 422
    assert invalid.json()["detail"] == "Request parameter validation failed"
    assert invalid.json()["errors"][0]["msg"] == (
        "String should have at most 100 characters"
    )

    corrected = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "x" * 100}
    )
    assert corrected.status_code == 201
    assert corrected.json()["name"] == "x" * 100
    assert corrected.json()["access_role"] == "Owner"
