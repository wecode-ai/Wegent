# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import Request
from starlette.datastructures import Headers

from app.services.llm_proxy_service import proxy_llm_responses


async def test_proxy_llm_responses_disables_downstream_buffering():
    request = MagicMock(spec=Request)
    request.body = AsyncMock(return_value=b'{"model":"public-model","input":"hello"}')
    request.headers = Headers(
        {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "x-wegent-model-type": "public",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": "0",
        }
    )
    upstream_response = MagicMock(
        status_code=200,
        headers={"content-type": "text/event-stream"},
    )

    async def upstream_chunks():
        yield b"data: first\n\n"
        yield b"data: second\n\n"

    upstream_response.aiter_raw = upstream_chunks
    client = MagicMock()
    client.send = AsyncMock(return_value=upstream_response)
    client.aclose = AsyncMock()

    with (
        patch(
            "app.services.llm_proxy_service.resolve_llm_proxy_model_config",
            return_value={
                "base_url": "https://provider.example.com/v1",
                "model_id": "provider-model",
                "api_format": "responses",
                "api_key": "provider-key",
            },
        ),
        patch("app.services.llm_proxy_service.httpx.AsyncClient", return_value=client),
    ):
        response = await proxy_llm_responses(
            request,
            MagicMock(),
            SimpleNamespace(id=7),
        )

    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["connection"] == "keep-alive"
    assert response.headers["x-accel-buffering"] == "no"
    assert [chunk async for chunk in response.body_iterator] == [
        b"data: first\n\n",
        b"data: second\n\n",
    ]
    client.aclose.assert_awaited_once()
