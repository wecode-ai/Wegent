# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for WeCode user API key resolution in the Backend LLM proxy."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, Request
from starlette.datastructures import Headers

import wecode.service.llm_proxy_service_patch as llm_proxy_patch
from app.models.kind import Kind
from app.services.llm_proxy_service import proxy_llm_responses


def _add_placeholder_model(test_db, user_id: int) -> Kind:
    model = Kind(
        user_id=user_id,
        kind="Model",
        name="wecode-placeholder-model",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "wecode-placeholder-model",
                "namespace": "default",
            },
            "spec": {
                "protocol": "openai-responses",
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": "provider-model-id",
                        "base_url": "https://api.example.com/v1",
                        "api_key": "${WECODE_USER_API_KEY}",
                    }
                },
            },
        },
        is_active=True,
    )
    test_db.add(model)
    test_db.commit()
    return model


def _proxy_request(user_id: int) -> MagicMock:
    request = MagicMock(spec=Request)
    request.body = AsyncMock(
        return_value=b'{"model":"wecode-placeholder-model","input":"hello"}'
    )
    request.headers = Headers(
        {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(user_id),
        }
    )
    return request


@pytest.mark.asyncio
async def test_proxy_replaces_wecode_user_api_key_before_forwarding(
    test_db,
    test_user,
    monkeypatch,
):
    _add_placeholder_model(test_db, test_user.id)
    monkeypatch.setenv("WECODE_USER_API_KEY", "sk-global-fallback")
    key_resolver = AsyncMock(return_value="sk-user-specific")
    monkeypatch.setattr(llm_proxy_patch, "get_or_create_apikey_async", key_resolver)

    upstream_response = MagicMock(
        status_code=200,
        headers={"content-type": "text/event-stream"},
    )

    async def response_body():
        yield b"data: ok\n\n"

    upstream_response.aiter_raw = response_body
    client = AsyncMock()
    client.send = AsyncMock(return_value=upstream_response)
    client.aclose = AsyncMock()
    monkeypatch.setattr(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        lambda *args, **kwargs: client,
    )

    response = await proxy_llm_responses(
        _proxy_request(test_user.id),
        test_db,
        test_user,
    )
    body = b"".join([chunk async for chunk in response.body_iterator])

    sent_request = client.send.await_args.args[0]
    assert body == b"data: ok\n\n"
    assert sent_request.headers["Authorization"] == "Bearer sk-user-specific"
    assert "WECODE_USER_API_KEY" not in sent_request.headers["Authorization"]
    key_resolver.assert_awaited_once_with(test_user.user_name)


@pytest.mark.asyncio
async def test_proxy_does_not_forward_when_wecode_api_key_lookup_fails(
    test_db,
    test_user,
    monkeypatch,
):
    _add_placeholder_model(test_db, test_user.id)
    key_resolver = AsyncMock(side_effect=RuntimeError("credential service unavailable"))
    monkeypatch.setattr(llm_proxy_patch, "get_or_create_apikey_async", key_resolver)
    client_factory = MagicMock()
    monkeypatch.setattr(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        client_factory,
    )

    with pytest.raises(HTTPException) as exc_info:
        await proxy_llm_responses(
            _proxy_request(test_user.id),
            test_db,
            test_user,
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "Failed to resolve model credentials"
    client_factory.assert_not_called()
