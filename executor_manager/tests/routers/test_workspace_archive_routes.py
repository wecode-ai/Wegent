# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import httpx
import pytest

from executor_manager.routers import routers


@pytest.mark.asyncio
async def test_archive_executor_workspace_returns_404_when_runtime_unavailable(mocker):
    request = routers.ArchiveExecutorRequest(
        task_id=1385,
        upload_url="https://minio.local/upload/archive",
        executor_name="missing-executor",
        executor_namespace="default",
    )
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "failed",
        "error_msg": "missing",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.archive_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_archive_executor_workspace_forwards_payload(mocker):
    request = routers.ArchiveExecutorRequest(
        task_id=1385,
        upload_url="https://minio.local/upload/archive",
        executor_name="executor-1",
        executor_namespace="default",
        max_size_mb=321,
    )
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor.local:8000",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    response = mocker.MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"size_bytes": 1024}
    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.post = mocker.AsyncMock(return_value=response)
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    result = await routers.archive_executor_workspace(request, http_request)

    assert result == {"size_bytes": 1024}
    client.post.assert_awaited_once_with(
        "http://executor.local:8000/api/archive",
        json={
            "task_id": 1385,
            "upload_url": "https://minio.local/upload/archive",
            "max_size_mb": 321,
        },
        headers={"Content-Type": "application/json"},
    )


@pytest.mark.asyncio
async def test_restore_executor_workspace_wraps_http_errors(mocker):
    request = routers.RestoreExecutorRequest(
        task_id=1385,
        download_url="https://minio.local/download/archive",
        executor_name="executor-1",
        executor_namespace="default",
    )
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor.local:8000",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.post = mocker.AsyncMock(side_effect=httpx.HTTPError("boom"))
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.restore_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 500
    assert "HTTP error" in exc_info.value.detail
