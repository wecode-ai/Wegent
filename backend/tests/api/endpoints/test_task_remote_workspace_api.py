# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.services.execution.stream_client import StreamWorkerExecutionError
from app.services.execution.web_stream_client import WebRawStreamResponse


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_remote_workspace_status_endpoint(test_client: TestClient, test_token: str):
    with patch(
        "app.api.endpoints.adapter.tasks.web_stream_worker_client.execute",
        new=AsyncMock(
            return_value={
                "connected": True,
                "available": True,
                "root_path": "/workspace",
                "reason": None,
            }
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
    with patch(
        "app.api.endpoints.adapter.tasks.web_stream_worker_client.execute",
        new=AsyncMock(
            side_effect=StreamWorkerExecutionError(
                "Path must stay within /workspace/1",
                status_code=400,
            )
        ),
    ):
        response = test_client.get(
            "/api/tasks/1/remote-workspace/tree",
            params={"path": "/workspace/../etc"},
            headers=_auth_header(test_token),
        )

    assert response.status_code == 400


def test_remote_workspace_file_endpoint_relays_worker_body(
    test_client: TestClient,
    test_token: str,
) -> None:
    async def body():
        yield b"hello"
        yield b" world"

    with patch(
        "app.api.endpoints.adapter.tasks.web_stream_worker_client.open_raw_stream",
        new=AsyncMock(
            return_value=WebRawStreamResponse(
                metadata={
                    "content_type": "text/plain",
                    "content_disposition": 'attachment; filename="hello.txt"',
                },
                body=body(),
            )
        ),
    ) as open_stream:
        response = test_client.get(
            "/api/tasks/1/remote-workspace/file",
            params={"path": "/workspace/hello.txt", "disposition": "attachment"},
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.content == b"hello world"
    assert response.headers["content-type"].startswith("text/plain")
    assert "hello.txt" in response.headers["content-disposition"]
    assert open_stream.await_args.args[1] == {
        "task_id": 1,
        "user_id": 1,
        "path": "/workspace/hello.txt",
        "disposition": "attachment",
    }
