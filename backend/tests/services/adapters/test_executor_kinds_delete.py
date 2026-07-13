from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import HTTPException

from app.services.adapters.executor_kinds import ExecutorKindsService


@pytest.mark.unit
def test_delete_executor_task_sync_raises_on_failed_response():
    service = ExecutorKindsService(Mock())
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"status": "failed", "error_msg": "delete failed"}

    with patch("requests.post", return_value=response):
        with pytest.raises(HTTPException, match="delete failed"):
            service.delete_executor_task_sync("executor-1", "wb-plat-ide")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_sandbox_by_task_id_success():
    from wecode.service.executor_kinds_patch import cleanup_sandbox_by_task_id_async

    mock_response = Mock()
    mock_response.raise_for_status.return_value = None
    mock_response.json.return_value = {
        "deleted": True,
        "redis_cleared": True,
        "archived": True,
        "reason": "sandbox_deleted",
    }

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=mock_response)

    with patch("httpx.AsyncClient", return_value=mock_client):
        result = await cleanup_sandbox_by_task_id_async(
            Mock(), task_id=1234, archive_before_delete=True
        )

    assert result["deleted"] is True
    assert result["redis_cleared"] is True
    assert result["archived"] is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_sandbox_by_task_id_invalid_task_id():
    from wecode.service.executor_kinds_patch import cleanup_sandbox_by_task_id_async

    with pytest.raises(HTTPException, match="task_id must be a positive integer"):
        await cleanup_sandbox_by_task_id_async(Mock(), task_id=0)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cleanup_sandbox_by_task_id_http_error():
    import httpx

    from wecode.service.executor_kinds_patch import cleanup_sandbox_by_task_id_async

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))

    with patch("httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(HTTPException, match="Error cleaning up sandbox"):
            await cleanup_sandbox_by_task_id_async(Mock(), task_id=1234)
