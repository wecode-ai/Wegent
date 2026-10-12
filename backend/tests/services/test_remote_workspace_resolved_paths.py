# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi import HTTPException

from app.services.remote_workspace_paths import resolve_executor_workspace_root
from app.services.remote_workspace_service import RemoteWorkspaceService

ROOT = "/srv/workspaces/demo-12345678"


@pytest.fixture
def reported_root():
    return ROOT


@pytest.fixture
def runtime(reported_root):
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/filesystem.Filesystem/Stat":
            assert json.loads(request.content) == {"path": "/workspace/42"}
            return httpx.Response(
                200,
                json={"entry": {"path": reported_root, "type": "FILE_TYPE_DIRECTORY"}},
            )
        path = request.url.params["path"]
        assert path == reported_root or path.startswith(f"{reported_root}/")
        if request.url.path.endswith("/tree"):
            name = ".claude" if path == reported_root else "settings.json"
            return httpx.Response(
                200,
                json=[
                    {
                        "name": name,
                        "path": f"{path}/{name}",
                        "is_directory": path == reported_root,
                    }
                ],
            )
        assert request.url.path.endswith("/file")
        return httpx.Response(
            200, content=b"{}", headers={"Content-Type": "text/plain"}
        )

    service = RemoteWorkspaceService(executor_manager_url="http://manager")
    client_class = httpx.Client
    transport = httpx.MockTransport(respond)
    with (
        patch.object(
            service,
            "_get_task_detail",
            return_value={"subtasks": [{"executor_name": "runtime"}]},
        ),
        patch.object(service, "_get_sandbox_payload", return_value=None),
        patch.object(
            service,
            "_get_executor_payload",
            return_value={"status": "success", "base_url": "http://runtime"},
        ),
        patch(
            "httpx.Client",
            side_effect=lambda **kw: client_class(transport=transport, **kw),
        ),
    ):
        yield service, requests


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reported_root", [ROOT, "/workspace/demo-12345678", "/workspace/42"]
)
async def test_resolved_root_round_trips_tree_preview_and_download(
    runtime, reported_root
):
    service, requests = runtime
    db = Mock()
    status = service.get_status(db, 42, 100)
    assert status.available is True
    assert status.root_path == reported_root

    tree = service.list_tree(db, 42, 100, status.root_path)
    assert tree.path == reported_root
    assert tree.entries[0].path == f"{reported_root}/.claude"
    nested = service.list_tree(db, 42, 100, tree.entries[0].path)
    file_path = nested.entries[0].path
    assert nested.path == f"{reported_root}/.claude"
    assert file_path == f"{reported_root}/.claude/settings.json"

    for disposition in ("inline", "attachment"):
        response = service.stream_file(db, 42, 100, file_path, disposition)
        assert response.headers["Content-Disposition"].startswith(disposition)
        assert b"".join([part async for part in response.body_iterator]) == b"{}"
    file_requests = [r for r in requests if r.url.path.endswith("/file")]
    assert len(file_requests) == 2
    assert all(r.url.params["path"] == file_path for r in file_requests)
    # Status, two trees, and two downloads each resolve their runtime only once.
    assert service._get_task_detail.call_count == 5
    assert service._get_sandbox_payload.call_count == 5
    assert service._get_executor_payload.call_count == 5


@pytest.mark.parametrize(
    "path",
    [
        f"{ROOT}/../other/secret",
        f"{ROOT}-other/secret",
        "/workspace/demo-12345678/.claude",
        "/workspace/42/demo-12345678/.claude",
        "/etc/passwd",
    ],
)
@pytest.mark.parametrize("operation", ["list_tree", "stream_file"])
def test_rejects_paths_outside_bound_repository(runtime, path, operation):
    service, requests = runtime
    with pytest.raises(HTTPException) as error:
        getattr(service, operation)(Mock(), 42, 100, path)
    assert error.value.status_code == 400
    assert all(r.url.path == "/filesystem.Filesystem/Stat" for r in requests)


def test_authorizes_task_before_querying_runtime(runtime):
    service, requests = runtime
    service._get_task_detail.side_effect = HTTPException(403, "Forbidden")
    with pytest.raises(HTTPException) as error:
        service.list_tree(Mock(), 42, 100)
    assert error.value.status_code == 403
    assert requests == []


def test_missing_workspace_is_starting_then_recovers(runtime):
    service, _ = runtime
    with patch(
        "app.services.remote_workspace_service.resolve_executor_workspace_root",
        side_effect=HTTPException(404, "Workspace directory not found"),
    ):
        status = service.get_status(Mock(), 42, 100)
    assert status.connected is True
    assert status.available is False
    assert status.reason == "starting"
    assert service.get_status(Mock(), 42, 100).root_path == ROOT


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"entry": {"path": "relative", "type": "FILE_TYPE_DIRECTORY"}},
        {"entry": {"path": "/", "type": "FILE_TYPE_DIRECTORY"}},
        {"entry": {"path": f"{ROOT}/../other", "type": "FILE_TYPE_DIRECTORY"}},
        {"entry": {"path": ROOT, "type": "FILE_TYPE_FILE"}},
    ],
)
def test_rejects_invalid_runtime_root(payload):
    client = Mock()
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    client.post.return_value = httpx.Response(200, json=payload)
    with (
        patch("httpx.Client", return_value=client),
        pytest.raises(HTTPException) as error,
    ):
        resolve_executor_workspace_root("http://runtime", 42, 5)
    assert error.value.status_code == 502
