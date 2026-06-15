# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from chat_shell.tools.sandbox.client import SandboxClient, SandboxExecutionResult


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError(
                "error",
                request=None,
                response=self,
            )

    def json(self) -> dict:
        return self._payload


class _FakeHttpClient:
    def __init__(self):
        self.get = AsyncMock()
        self.post = AsyncMock()


@pytest.mark.asyncio
async def test_ensure_sandbox_revalidates_cached_running_sandbox():
    """A cached running sandbox should be revalidated before reuse."""
    http_client = _FakeHttpClient()
    http_client.get.return_value = _FakeResponse(404)
    http_client.post.return_value = _FakeResponse(
        200,
        {"sandbox_id": "1385", "status": "running"},
    )

    client = SandboxClient(
        executor_manager_url="http://executor-manager.local",
        task_id=1385,
        user_id=7,
    )
    client._sandbox_id = "1385"
    client._sandbox_status = "running"
    client._http_client = http_client

    sandbox_id, error = await client.ensure_sandbox()

    assert error is None
    assert sandbox_id == "1385"
    assert http_client.get.await_count == 2
    http_client.post.assert_awaited_once()


@pytest.mark.asyncio
async def test_execute_recreates_sandbox_once_when_start_returns_404(mocker):
    """Starting execution in a deleted sandbox should clear cache and retry once."""
    client = SandboxClient(
        executor_manager_url="http://executor-manager.local",
        task_id=1385,
        user_id=7,
    )
    ensure = mocker.patch.object(
        client,
        "ensure_sandbox",
        new=AsyncMock(side_effect=[("old-sandbox", None), ("new-sandbox", None)]),
    )
    start = mocker.patch.object(
        client,
        "_start_execution",
        new=AsyncMock(
            side_effect=[
                ("", 0, "HTTP error starting execution: 404"),
                ("execution-1", 99, None),
            ]
        ),
    )
    mocker.patch.object(
        client,
        "_poll_execution",
        new=AsyncMock(
            return_value=SandboxExecutionResult(success=True, status="completed")
        ),
    )

    result = await client.execute("print('hello')", timeout=30)

    assert result.success is True
    assert ensure.await_count == 2
    assert start.await_args_list[1].args[0] == "new-sandbox"
