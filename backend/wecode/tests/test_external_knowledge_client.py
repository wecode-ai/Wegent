# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from wecode.config.external_knowledge_config import external_knowledge_settings
from wecode.service.external_knowledge.client import ApKnowledgeMcpClient
from wecode.service.external_knowledge.providers.ap import LIST_KNOWLEDGE_BASES_TOOL

pytestmark = pytest.mark.usefixtures("configure_external_knowledge")


def _jsonrpc_payload(payload: dict, *, is_error: bool = False) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "content": [
                {
                    "type": "text",
                    "text": __import__("json").dumps(payload),
                }
            ],
            "isError": is_error,
        },
    }


@pytest.mark.asyncio
async def test_client_sends_auth_headers_and_parses_text_payload():
    settings = external_knowledge_settings
    client = ApKnowledgeMcpClient(settings)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = _jsonrpc_payload({"total": 0, "items": []})
    mock_response.raise_for_status = MagicMock()

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_response
    mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
    mock_http_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.external_knowledge.client.httpx.AsyncClient",
        return_value=mock_http_client,
    ):
        result = await client.call_tool(
            LIST_KNOWLEDGE_BASES_TOOL,
            {"scope": "all"},
            "230473",
        )

    assert result == {"total": 0, "items": []}
    _, kwargs = mock_http_client.post.call_args
    assert kwargs["headers"]["Authorization"] == "Bearer service-token"
    assert kwargs["headers"]["X-User-Name"] == "230473"
    assert kwargs["json"]["method"] == "tools/call"
    assert kwargs["json"]["params"]["name"] == LIST_KNOWLEDGE_BASES_TOOL


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (200, True),
        (204, True),
        (401, False),
        (403, False),
        (404, False),
        (500, False),
    ],
)
async def test_client_health_only_accepts_success_status_codes(status_code, expected):
    client = ApKnowledgeMcpClient(external_knowledge_settings)

    mock_response = MagicMock()
    mock_response.status_code = status_code

    mock_http_client = AsyncMock()
    mock_http_client.get.return_value = mock_response
    mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
    mock_http_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.external_knowledge.client.httpx.AsyncClient",
        return_value=mock_http_client,
    ):
        result = await client.health()

    assert result is expected
    _, kwargs = mock_http_client.get.call_args
    assert kwargs["headers"]["Authorization"] == "Bearer service-token"
    assert kwargs["headers"]["X-User-Name"] == "health-check"


@pytest.mark.asyncio
async def test_client_health_returns_false_for_http_errors():
    client = ApKnowledgeMcpClient(external_knowledge_settings)

    mock_http_client = AsyncMock()
    mock_http_client.get.side_effect = httpx.TimeoutException("timeout")
    mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
    mock_http_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.external_knowledge.client.httpx.AsyncClient",
        return_value=mock_http_client,
    ):
        result = await client.health()

    assert result is False


@pytest.mark.asyncio
async def test_client_maps_is_error_payload():
    settings = external_knowledge_settings
    client = ApKnowledgeMcpClient(settings)

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = _jsonrpc_payload(
        {"error": "slow down", "code": "rate_limited"},
        is_error=True,
    )
    mock_response.raise_for_status = MagicMock()

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_response
    mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
    mock_http_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.external_knowledge.client.httpx.AsyncClient",
        return_value=mock_http_client,
    ):
        with pytest.raises(Exception) as exc_info:
            await client.call_tool(LIST_KNOWLEDGE_BASES_TOOL, {}, "230473")

    assert getattr(exc_info.value, "code") == "rate_limited"
    assert getattr(exc_info.value, "status_code") == 429
