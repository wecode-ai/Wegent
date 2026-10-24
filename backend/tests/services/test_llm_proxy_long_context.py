# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException, Request
from starlette.datastructures import URL, Headers

from app.models.user import User
from app.services.chat.trigger.request_preparation import (
    _build_cloud_gateway_model_config,
)
from app.services.llm_proxy_service import (
    _normalize_context_overflow,
    proxy_llm_responses,
    strip_long_context_suffix,
)
from tests.services.test_llm_proxy_service import _model_kind


@pytest.mark.parametrize(
    ("model_name", "expected"),
    [
        ("deepseek-v4-flash[1m]", "deepseek-v4-flash"),
        ("deepseek-v4-flash[1M]", "deepseek-v4-flash"),
        ("deepseek-v4-flash+1m", "deepseek-v4-flash"),
        ("deepseek-v4-flash", "deepseek-v4-flash"),
        ("[1m]", "[1m]"),
    ],
)
def test_strip_long_context_suffix(model_name: str, expected: str) -> None:
    """Strip client aliases without changing plain resource identifiers."""
    assert strip_long_context_suffix(model_name) == expected


@pytest.mark.parametrize(
    ("configured", "legacy", "expected"),
    [
        (
            {"context_window": 1_000_000, "max_output_tokens": 128_000},
            {},
            {"model_context_window": 1_000_000, "max_output_tokens": 128_000},
        ),
        (
            {},
            {"contextWindow": 1_000_000, "maxOutputTokens": 64_000},
            {"model_context_window": 1_000_000, "max_output_tokens": 64_000},
        ),
        (
            {"context_window": 2_000_000, "max_output_tokens": 96_000},
            {"contextWindow": 1_000_000, "maxOutputTokens": 64_000},
            {"model_context_window": 2_000_000, "max_output_tokens": 96_000},
        ),
        (
            {"context_window": None, "max_output_tokens": "invalid"},
            {"contextWindow": "1000000", "maxOutputTokens": "64000"},
            {"model_context_window": 1_000_000, "max_output_tokens": 64_000},
        ),
        (
            {"context_window": False, "max_output_tokens": 0},
            {"contextWindow": 1_000_000, "maxOutputTokens": 64_000},
            {"model_context_window": 1_000_000, "max_output_tokens": 64_000},
        ),
        (
            {"context_window": -1, "max_output_tokens": False},
            {"contextWindow": 0, "maxOutputTokens": "invalid"},
            {},
        ),
    ],
)
def test_cloud_gateway_config_includes_model_context_budget(
    test_db, test_user: User, monkeypatch, configured, legacy, expected
) -> None:
    """Send valid CRD limits to the executor, preferring current fields."""
    from app.core.config import settings

    model = _model_kind(0, protocol="claude")
    model.json["spec"]["modelConfig"].update(configured)
    model.json["spec"].update(legacy)
    test_db.add(model)
    test_db.commit()
    monkeypatch.setattr(settings, "WEGENT_BACKEND_PUBLIC_URL", "https://wegent.example")

    config = _build_cloud_gateway_model_config(
        test_db,
        model_name=model.name,
        creator=test_user,
        model_type="public",
        namespace="default",
        resource_user_id=0,
    )

    assert config is not None
    assert {
        key: config[key]
        for key in ("model_context_window", "max_output_tokens")
        if key in config
    } == expected


@pytest.mark.parametrize("body_length", [0, 1, 4, 8])
@pytest.mark.parametrize("context_window", [None, 0, 1, 1_000_000])
def test_normalized_context_overflow_always_reports_actual_above_limit(
    body_length: int, context_window: int | None
) -> None:
    """Keep Claude Code's compaction arithmetic valid for tiny estimates."""
    normalized = _normalize_context_overflow(
        status_code=460,
        body="对话内容太长".encode(),
        request_body_length=body_length,
        context_window=context_window,
    )

    assert normalized is not None
    message = normalized["error"]["message"]
    actual, limit = message.removeprefix("prompt is too long: ").split(" tokens > ")
    assert int(actual) > int(limit.removesuffix(" maximum")) > 0


def _proxy_request(model_name: str, user_id: int, path: str = "messages") -> MagicMock:
    """Build an authenticated gateway request without external services."""
    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=json.dumps(
            {
                "model": model_name,
                "messages": [{"role": "user", "content": "hello"}],
                "max_tokens": 1024,
            }
        ).encode()
    )
    request_mock.headers = Headers(
        {
            "content-type": "application/json",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(user_id),
        }
    )
    request_mock.url = URL(
        f"http://testserver/api/runtime-work/llm-responses-proxy/{path}"
    )
    return request_mock


def _upstream_response(status_code: int, body: bytes) -> MagicMock:
    """Expose the same body to buffered and streaming response consumers."""
    upstream_response_mock = MagicMock()
    upstream_response_mock.status_code = status_code
    upstream_response_mock.headers = {"content-type": "application/json"}
    upstream_response_mock.aread = AsyncMock(return_value=body)

    async def chunks():
        yield body

    upstream_response_mock.aiter_raw = chunks
    return upstream_response_mock


async def test_proxy_llm_responses_strips_long_context_alias(test_db, test_user: User):
    """Resolve the authorized resource and send the provider's plain model ID."""
    model = _model_kind(
        test_user.id,
        name="deepseek-v4-flash",
        model_id="provider-model[1m]",
        protocol="claude",
        api_key="sk-anthropic-key",
        base_url="https://api.anthropic.com",
    )
    test_db.add(model)
    test_db.commit()
    request_mock = _proxy_request("deepseek-v4-flash[1m]", test_user.id)
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=_upstream_response(200, b"data: ok\n\n"))
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 200
    sent_request = client_mock.send.call_args[0][0]
    assert str(sent_request.url) == "https://api.anthropic.com/v1/messages"
    assert json.loads(sent_request.content)["model"] == "provider-model"


async def test_proxy_llm_responses_normalizes_context_overflow_for_messages(
    test_db, test_user: User
):
    """Translate a provider overflow into Claude Code's compaction trigger."""
    model = _model_kind(
        test_user.id,
        name="overflow-model",
        protocol="claude",
        api_key="sk-anthropic-key",
        base_url="https://api.anthropic.com",
    )
    model.json["spec"]["modelConfig"]["context_window"] = 1_000_000
    test_db.add(model)
    test_db.commit()
    request_mock = _proxy_request("overflow-model", test_user.id)
    upstream_body = (
        b'{"error":{"code":"InvalidParameter","message":'
        b'"Input exceeds the context limit (1048568 tokens)."}}'
    )
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=_upstream_response(400, upstream_body))
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 400
    assert json.loads(response.body) == {
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": "prompt is too long: 1048568 tokens > 1000000 maximum",
        },
    }
    client_mock.aclose.assert_awaited_once()


async def test_proxy_llm_responses_leaves_overflow_untouched_for_responses(
    test_db, test_user: User
):
    """Preserve the upstream error contract for Responses callers."""
    model = _model_kind(
        test_user.id,
        name="codex-overflow-model",
        protocol="openai-responses",
        api_key="sk-responses-key",
    )
    test_db.add(model)
    test_db.commit()
    request_mock = _proxy_request(
        "codex-overflow-model", test_user.id, path="responses"
    )
    upstream_body = (
        b'{"error":{"message":"Input exceeds the context limit (1048568 tokens)."}}'
    )
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=_upstream_response(400, upstream_body))
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 400
    assert response.body == upstream_body


async def test_proxy_llm_responses_leaves_unrelated_bad_request_untouched(
    test_db, test_user: User
):
    """Preserve unrelated Anthropic errors and their status codes."""
    model = _model_kind(
        test_user.id,
        name="plain-error-model",
        protocol="claude",
        api_key="sk-anthropic-key",
        base_url="https://api.anthropic.com",
    )
    test_db.add(model)
    test_db.commit()
    request_mock = _proxy_request("plain-error-model", test_user.id)
    upstream_body = b'{"error":{"message":"invalid parameter: max_tokens"}}'
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=_upstream_response(400, upstream_body))
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 400
    assert response.body == upstream_body


@pytest.mark.parametrize("error_type", [httpx.ReadError, httpx.ReadTimeout])
async def test_proxy_closes_client_when_upstream_error_body_read_fails(
    test_db, test_user: User, error_type: type[httpx.HTTPError]
) -> None:
    """Return a gateway error and release the client when an error body breaks."""
    model = _model_kind(test_user.id, protocol="claude")
    test_db.add(model)
    test_db.commit()
    upstream_response = _upstream_response(460, b"")
    upstream_response.aread.side_effect = error_type("upstream disconnected")
    client = AsyncMock()
    client.send.return_value = upstream_response

    with patch("app.services.llm_proxy_service.httpx.AsyncClient", return_value=client):
        with pytest.raises(HTTPException) as caught:
            await proxy_llm_responses(
                _proxy_request(model.name, test_user.id), test_db, test_user
            )

    assert caught.value.status_code == 502
    assert caught.value.detail == "Upstream request failed: upstream disconnected"
    client.aclose.assert_awaited_once()


async def test_proxy_closes_client_when_error_body_read_is_cancelled(
    test_db, test_user: User
) -> None:
    """Release the upstream client while allowing cancellation to propagate."""
    model = _model_kind(test_user.id, protocol="claude")
    test_db.add(model)
    test_db.commit()
    upstream_response = _upstream_response(460, b"")
    upstream_response.aread.side_effect = asyncio.CancelledError()
    client = AsyncMock()
    client.send.return_value = upstream_response

    with patch("app.services.llm_proxy_service.httpx.AsyncClient", return_value=client):
        with pytest.raises(asyncio.CancelledError):
            await proxy_llm_responses(
                _proxy_request(model.name, test_user.id), test_db, test_user
            )

    client.aclose.assert_awaited_once()
