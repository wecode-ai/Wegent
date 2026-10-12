# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.schemas.remote_workspace import (
    RemoteWorkspaceStatusResponse,
    RemoteWorkspaceTreeResponse,
)


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_remote_workspace_status_endpoint(test_client: TestClient, test_token: str):
    with patch(
        "app.api.endpoints.adapter.tasks.remote_workspace_service.get_status",
        return_value=RemoteWorkspaceStatusResponse(
            connected=True,
            available=True,
            root_path="/workspace",
            reason=None,
        ),
    ):
        response = test_client.get(
            "/api/tasks/1/remote-workspace/status",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    payload = response.json()
    assert "connected" in payload
    assert payload["connected"] is True


def test_remote_workspace_tree_endpoint_rejects_escape(
    test_client: TestClient, test_token: str
):
    response = test_client.get(
        "/api/tasks/1/remote-workspace/tree",
        params={"path": "/workspace/../etc"},
        headers=_auth_header(test_token),
    )

    assert response.status_code == 400


def test_tree_without_path_requests_the_resolved_task_root(test_client, test_token):
    root = "/srv/workspaces/demo-12345678"
    with patch(
        "app.api.endpoints.adapter.tasks.remote_workspace_service.list_tree",
        return_value=RemoteWorkspaceTreeResponse(path=root, entries=[]),
    ) as list_tree:
        response = test_client.get(
            "/api/tasks/1/remote-workspace/tree", headers=_auth_header(test_token)
        )
    assert response.status_code == 200
    assert response.json() == {"path": root, "entries": []}
    assert list_tree.call_args.kwargs["path"] is None
