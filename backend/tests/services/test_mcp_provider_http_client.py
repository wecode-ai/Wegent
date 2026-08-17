# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import httpx
import pytest

from app.services.mcp_providers.core.config import MCPROUTER_CONFIG
from app.services.mcp_providers.core.http_client import (
    HTTPClientError,
    MCPProviderHTTPClient,
)


def test_mcprouter_uses_current_api_key_url() -> None:
    assert MCPROUTER_CONFIG.api_key_url == "https://mcprouter.co/settings/keys"


@pytest.mark.anyio
async def test_fetch_all_servers_posts_mcprouter_pagination_body() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "servers": [
                        {
                            "server_key": "example",
                            "title": "Example",
                            "server_url": "https://example.com/mcp",
                        }
                    ]
                },
            },
        )

    client = MCPProviderHTTPClient(MCPROUTER_CONFIG)
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    try:
        servers = await client.fetch_all_servers("token")
    finally:
        await client.close()

    assert len(servers) == 1
    assert json.loads(requests[0].content) == {"page": 1, "limit": 100}
    assert requests[0].url.query == b""


def test_check_response_accepts_mcprouter_zero_code() -> None:
    client = MCPProviderHTTPClient(MCPROUTER_CONFIG)
    response = httpx.Response(
        200,
        json={"code": 0, "message": "ok", "data": {"servers": []}},
    )

    assert client._check_response(response)["code"] == 0


def test_check_response_rejects_mcprouter_nonzero_code() -> None:
    client = MCPProviderHTTPClient(MCPROUTER_CONFIG)
    response = httpx.Response(
        200,
        json={"code": 1001, "message": "Invalid request", "data": None},
    )

    with pytest.raises(HTTPClientError) as exc_info:
        client._check_response(response)

    assert exc_info.value.code == "api_error"
    assert exc_info.value.message == "Invalid request"
