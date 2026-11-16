# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Backend callback client authentication."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from executor_manager.clients.callback_client import CallbackClient


class _AsyncClientContext:
    def __init__(self, client):
        self._client = client

    async def __aenter__(self):
        return self._client

    async def __aexit__(self, exc_type, exc, traceback):
        return False


@pytest.mark.asyncio
async def test_send_error_uses_backend_service_token(mocker, monkeypatch):
    monkeypatch.setenv("TASK_API_DOMAIN", "http://backend:8000")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "service-token")
    client = MagicMock()
    client.post = AsyncMock(return_value=MagicMock(status_code=200, text="ok"))
    mocker.patch(
        "executor_manager.clients.callback_client.traced_async_client",
        return_value=_AsyncClientContext(client),
    )

    sent = await CallbackClient().send_error(
        task_id=42,
        subtask_id=43,
        error_message="executor crashed",
    )

    assert sent is True
    client.post.assert_awaited_once_with(
        "http://backend:8000/api/internal/callback",
        json={
            "event_type": "error",
            "task_id": 42,
            "subtask_id": 43,
            "data": {
                "code": "executor_crash",
                "message": "executor crashed",
            },
        },
        headers={"Authorization": "Bearer service-token"},
    )
