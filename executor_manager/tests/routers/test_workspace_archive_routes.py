# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import httpx
import pytest

from executor_manager.routers import routers

# =============================================================================
# Helpers
# =============================================================================


def _mock_request(task_id=1385, max_size_mb=500):
    return routers.ArchiveExecutorRequest(
        task_id=task_id,
        upload_url="https://minio.local/upload/archive",
        executor_name="executor-1",
        executor_namespace="default",
        max_size_mb=max_size_mb,
    )


def _mock_restore_request(task_id=1385):
    return routers.RestoreExecutorRequest(
        task_id=task_id,
        download_url="https://minio.local/download/archive",
        executor_name="executor-1",
        executor_namespace="default",
    )


def _mock_http_request():
    return SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))


# =============================================================================
# Archive existing tests
# =============================================================================


@pytest.mark.asyncio
async def test_archive_executor_workspace_returns_404_when_runtime_unavailable(mocker):
    request = _mock_request()
    http_request = _mock_http_request()
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
    request = _mock_request(max_size_mb=321)
    http_request = _mock_http_request()
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


# =============================================================================
# Archive upstream error mapping tests
# =============================================================================


@pytest.mark.asyncio
async def test_archive_upstream_404_returns_502(mocker):
    request = _mock_request()
    http_request = _mock_http_request()
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor.local:8000",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    response = mocker.MagicMock()
    response.status_code = 404
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Not Found", request=mocker.MagicMock(), response=response
    )
    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.post = mocker.AsyncMock(return_value=response)
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.archive_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail
    assert "executor.local" not in exc_info.value.detail
    assert "minio.local" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_archive_upstream_500_returns_502(mocker):
    request = _mock_request()
    http_request = _mock_http_request()
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor.local:8000",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    response = mocker.MagicMock()
    response.status_code = 500
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Internal Server Error", request=mocker.MagicMock(), response=response
    )
    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.post = mocker.AsyncMock(return_value=response)
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.archive_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_archive_upstream_timeout_returns_504(mocker):
    request = _mock_request()
    http_request = _mock_http_request()
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
    client.post = mocker.AsyncMock(side_effect=httpx.TimeoutException("timed out"))
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.archive_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 504
    assert "host.docker.internal" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_archive_upstream_connection_error_returns_502(mocker):
    request = _mock_request()
    http_request = _mock_http_request()
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
    client.post = mocker.AsyncMock(side_effect=httpx.ConnectError("connection refused"))
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.archive_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_archive_generic_http_error_returns_502_without_url_leak(mocker):
    request = _mock_request()
    http_request = _mock_http_request()
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
    client.post = mocker.AsyncMock(
        side_effect=httpx.HTTPError(
            "boom http://host.docker.internal:8001/api/archive https://minio.local/upload"
        )
    )
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.archive_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail
    assert "minio.local" not in exc_info.value.detail
    assert "executor.local" not in exc_info.value.detail
    assert "HTTP error:" not in exc_info.value.detail


# =============================================================================
# Restore existing + upstream error mapping tests
# =============================================================================


@pytest.mark.asyncio
async def test_restore_upstream_404_returns_502(mocker):
    request = _mock_restore_request()
    http_request = _mock_http_request()
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor.local:8000",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    response = mocker.MagicMock()
    response.status_code = 404
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Not Found", request=mocker.MagicMock(), response=response
    )
    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.post = mocker.AsyncMock(return_value=response)
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.restore_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail
    assert "executor.local" not in exc_info.value.detail
    assert "minio.local" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_restore_upstream_timeout_returns_504(mocker):
    request = _mock_restore_request()
    http_request = _mock_http_request()
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
    client.post = mocker.AsyncMock(side_effect=httpx.TimeoutException("timed out"))
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.restore_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 504
    assert "host.docker.internal" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_restore_generic_http_error_returns_502_without_url_leak(mocker):
    request = _mock_restore_request()
    http_request = _mock_http_request()
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
    client.post = mocker.AsyncMock(
        side_effect=httpx.HTTPError(
            "boom http://host.docker.internal:8001/api/restore https://minio.local/download"
        )
    )
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.restore_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail
    assert "minio.local" not in exc_info.value.detail
    assert "executor.local" not in exc_info.value.detail
    assert "HTTP error:" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_restore_upstream_connection_error_returns_502(mocker):
    request = _mock_restore_request()
    http_request = _mock_http_request()
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
    client.post = mocker.AsyncMock(side_effect=httpx.ConnectError("connection refused"))
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.restore_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail


@pytest.mark.asyncio
async def test_restore_upstream_500_returns_502(mocker):
    request = _mock_restore_request()
    http_request = _mock_http_request()
    mock_executor = mocker.MagicMock()
    mock_executor.get_container_address.return_value = {
        "status": "success",
        "base_url": "http://executor.local:8000",
    }
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=mock_executor
    )

    response = mocker.MagicMock()
    response.status_code = 500
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "Internal Server Error", request=mocker.MagicMock(), response=response
    )
    client = mocker.MagicMock()
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)
    client.post = mocker.AsyncMock(return_value=response)
    mocker.patch.object(routers, "traced_async_client", return_value=client)

    with pytest.raises(routers.HTTPException) as exc_info:
        await routers.restore_executor_workspace(request, http_request)

    assert exc_info.value.status_code == 502
    assert "host.docker.internal" not in exc_info.value.detail
