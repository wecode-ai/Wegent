# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi import HTTPException

from app.services.remote_workspace_service import (
    REMOTE_WORKSPACE_FILE_MAX_BYTES,
    RemoteWorkspaceFileRequest,
    RemoteWorkspaceService,
)


def test_prepare_file_stream_uses_running_sandbox_endpoint() -> None:
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {"subtasks": [{"executor_name": "", "executor_namespace": ""}]}

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "running", "base_url": "http://sandbox"},
        ),
    ):
        request = service.prepare_file_stream(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace/README.md",
            disposition="inline",
        )

    assert request == RemoteWorkspaceFileRequest(
        url="http://sandbox/files",
        params={"path": "/home/user/README.md"},
        normalized_path="/home/user/README.md",
        disposition="inline",
    )


def test_prepare_file_stream_uses_executor_manager_endpoint() -> None:
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [{"executor_name": "executor-1", "executor_namespace": "default"}]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(service, "_get_sandbox_payload", return_value=None),
        patch.object(
            service,
            "_resolve_workspace_base_url",
            return_value="http://runtime",
        ),
    ):
        request = service.prepare_file_stream(
            db=Mock(),
            task_id=7,
            user_id=100,
            path="/workspace/demo.zip",
            disposition="attachment",
        )

    assert request.url == (
        "http://executor-manager/executor-manager/executor/workspace/file"
    )
    assert request.params == {
        "task_id": 7,
        "path": "/workspace/7/demo.zip",
        "executor_name": "executor-1",
    }
    assert request.disposition == "attachment"


@pytest.mark.asyncio
async def test_open_file_stream_relays_chunks_and_safe_metadata() -> None:
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "text/plain", "content-length": "5"},
            content=b"hello",
            request=request,
        )
    )
    client = httpx.AsyncClient(transport=transport)
    request = RemoteWorkspaceFileRequest(
        url="http://sandbox/files",
        params={"path": "/home/user/hello.txt"},
        normalized_path="/home/user/hello.txt",
        disposition="attachment",
    )

    with patch(
        "app.services.remote_workspace_service.httpx.AsyncClient",
        return_value=client,
    ):
        stream = await service.open_file_stream(request)
        content = b"".join([chunk async for chunk in stream.chunks()])

    assert content == b"hello"
    assert stream.content_type == "text/plain"
    assert stream.content_disposition.startswith("attachment;")
    assert "hello.txt" in stream.content_disposition
    assert stream._closed is True


@pytest.mark.asyncio
async def test_open_file_stream_rejects_declared_oversize_before_body() -> None:
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-length": str(REMOTE_WORKSPACE_FILE_MAX_BYTES + 1)},
            request=request,
        )
    )
    client = httpx.AsyncClient(transport=transport)
    request = RemoteWorkspaceFileRequest(
        url="http://sandbox/files",
        params={},
        normalized_path="/home/user/archive.zip",
        disposition="attachment",
    )

    with (
        patch(
            "app.services.remote_workspace_service.httpx.AsyncClient",
            return_value=client,
        ),
        pytest.raises(HTTPException) as raised,
    ):
        await service.open_file_stream(request)

    assert raised.value.status_code == 413
    assert client.is_closed


@pytest.mark.asyncio
async def test_open_file_stream_maps_not_found_without_buffering_body() -> None:
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(404, content=b"missing", request=request)
    )
    client = httpx.AsyncClient(transport=transport)
    request = RemoteWorkspaceFileRequest(
        url="http://sandbox/files",
        params={},
        normalized_path="/home/user/missing.txt",
        disposition="inline",
    )

    with (
        patch(
            "app.services.remote_workspace_service.httpx.AsyncClient",
            return_value=client,
        ),
        pytest.raises(HTTPException) as raised,
    ):
        await service.open_file_stream(request)

    assert raised.value.status_code == 404
    assert client.is_closed


def test_non_ascii_filename_uses_rfc5987_disposition() -> None:
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")

    disposition = service._build_content_disposition(
        disposition="attachment",
        filename="出师表.txt",
    )

    assert disposition.startswith("attachment;")
    assert "filename*=UTF-8''" in disposition
    assert "%E5%87%BA%E5%B8%88%E8%A1%A8.txt" in disposition
