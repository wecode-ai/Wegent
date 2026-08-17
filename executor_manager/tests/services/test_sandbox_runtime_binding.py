# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for sandbox runtime heartbeat binding."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from executor_manager.services.sandbox.runtime_binding import (
    SandboxRuntimeBinder,
    SandboxRuntimeBindingError,
)


class _AsyncClientContext:
    def __init__(self, client):
        self._client = client

    async def __aenter__(self):
        return self._client

    async def __aexit__(self, exc_type, exc, traceback):
        return False


@pytest.mark.asyncio
async def test_bind_targets_runtime_endpoint(mocker):
    binder = SandboxRuntimeBinder()
    request_bind = mocker.patch.object(
        binder,
        "_request_bind",
        new_callable=AsyncMock,
    )

    await binder.bind("http://sandbox:8080/", "12345")

    request_bind.assert_awaited_once_with(
        "http://sandbox:8080/v1/runtime/bind",
        "12345",
    )


@pytest.mark.asyncio
async def test_request_bind_posts_sandbox_heartbeat_identity(mocker):
    """The runtime bind request carries the sandbox heartbeat contract."""
    binder = SandboxRuntimeBinder()
    response = MagicMock(status_code=200)
    client = MagicMock()
    client.post = AsyncMock(return_value=response)
    mocker.patch(
        "executor_manager.services.sandbox.runtime_binding.traced_async_client",
        return_value=_AsyncClientContext(client),
    )

    await binder._request_bind("http://sandbox:8080/v1/runtime/bind", "12345")

    client.post.assert_awaited_once_with(
        "http://sandbox:8080/v1/runtime/bind",
        json={"heartbeat_id": "12345", "heartbeat_type": "sandbox"},
    )


@pytest.mark.asyncio
async def test_request_bind_does_not_retry_binding_conflict(mocker):
    """A conflicting runtime identity is a permanent binding error."""
    binder = SandboxRuntimeBinder()
    response = MagicMock(status_code=409, text="already bound")
    client = MagicMock()
    client.post = AsyncMock(return_value=response)
    mocker.patch(
        "executor_manager.services.sandbox.runtime_binding.traced_async_client",
        return_value=_AsyncClientContext(client),
    )

    with pytest.raises(SandboxRuntimeBindingError, match="HTTP 409"):
        await binder._request_bind("http://sandbox:8080/v1/runtime/bind", "12345")

    assert client.post.await_count == 1
