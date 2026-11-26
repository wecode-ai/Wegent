# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import HTTPException

from executor_manager.routers import wegent_e2b_proxy


def test_touch_sandbox_activity_persists_proxy_activity(mocker):
    """Proxied E2B SDK calls should refresh sandbox activity for GC."""
    repository = MagicMock()
    manager = SimpleNamespace(_repository=repository)
    sandbox = MagicMock()
    sandbox.sandbox_id = "1385"

    mocker.patch.object(wegent_e2b_proxy, "get_sandbox_manager", return_value=manager)

    wegent_e2b_proxy._touch_sandbox_activity(sandbox)

    sandbox.touch.assert_called_once_with()
    repository.save_sandbox.assert_called_once_with(sandbox)


@pytest.mark.asyncio
async def test_proxy_transport_error_returns_typed_bad_gateway(mocker):
    """Transport failures should not become an empty 500 response."""
    sandbox = SimpleNamespace(metadata={"task_type": "task"})
    request = MagicMock()
    request.method = "POST"
    request.query_params = {}
    request.headers = {}
    request.body = mocker.AsyncMock(return_value=b"payload")
    client = MagicMock()
    client.request = mocker.AsyncMock(side_effect=httpx.ReadError(""))
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)

    mocker.patch.object(
        wegent_e2b_proxy,
        "_get_sandbox_info",
        new=mocker.AsyncMock(return_value=("http://sandbox:8080", sandbox)),
    )
    mocker.patch.object(wegent_e2b_proxy, "_touch_sandbox_activity")
    mocker.patch.object(
        wegent_e2b_proxy.httpx,
        "AsyncClient",
        return_value=client,
    )

    with pytest.raises(HTTPException) as exc_info:
        await wegent_e2b_proxy.proxy_to_sandbox(
            "sandbox-1",
            49983,
            "files",
            request,
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail["code"] == "sandbox_transport_error"
    assert "ReadError" in exc_info.value.detail["message"]


@pytest.mark.asyncio
async def test_proxy_preserves_upstream_response(mocker):
    """A received upstream response keeps its status and body."""
    sandbox = SimpleNamespace(metadata={"task_type": "task"})
    request = MagicMock()
    request.method = "POST"
    request.query_params = {}
    request.headers = {}
    request.body = mocker.AsyncMock(return_value=b"payload")
    upstream = MagicMock()
    upstream.status_code = 413
    upstream.headers = {"content-type": "application/json"}
    upstream.content = b'{"detail":"Request payload is too large"}'
    client = MagicMock()
    client.request = mocker.AsyncMock(return_value=upstream)
    client.__aenter__ = mocker.AsyncMock(return_value=client)
    client.__aexit__ = mocker.AsyncMock(return_value=None)

    mocker.patch.object(
        wegent_e2b_proxy,
        "_get_sandbox_info",
        new=mocker.AsyncMock(return_value=("http://sandbox:8080", sandbox)),
    )
    mocker.patch.object(wegent_e2b_proxy, "_touch_sandbox_activity")
    mocker.patch.object(
        wegent_e2b_proxy.httpx,
        "AsyncClient",
        return_value=client,
    )

    response = await wegent_e2b_proxy.proxy_to_sandbox(
        "sandbox-1",
        49983,
        "files",
        request,
    )

    assert response.status_code == 413
    assert await anext(response.body_iterator) == upstream.content
