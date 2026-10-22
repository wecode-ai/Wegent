# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the admin API routes."""

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_runtime.api.endpoints import admin
from shared.models import RemoteTestConnectionResponse


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(admin.router, prefix="/internal/rag")
    return TestClient(app)


def test_test_connection_route_returns_runtime_verdict() -> None:
    verdict = RemoteTestConnectionResponse(
        success=False,
        message="Connection failed",
    )

    with patch.object(admin, "AdminExecutor") as mock_executor_cls:
        mock_executor = mock_executor_cls.return_value
        mock_executor.test_connection = AsyncMock(return_value=verdict)

        response = _client().post(
            "/internal/rag/test-connection",
            json={"storage_type": "qdrant", "url": "http://qdrant:6333"},
        )

    assert response.status_code == 200
    assert response.json() == {"success": False, "message": "Connection failed"}
    mock_executor.test_connection.assert_awaited_once()
    request = mock_executor.test_connection.await_args.args[0]
    assert request.storage_type == "qdrant"
    assert request.url == "http://qdrant:6333"
