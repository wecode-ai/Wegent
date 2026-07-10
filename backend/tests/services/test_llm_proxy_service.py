# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Request
from starlette.datastructures import Headers

from app.models.kind import Kind
from app.models.user import User
from app.services import llm_proxy_service
from app.services.chat.trigger.unified import _build_codex_runtime_model_config
from app.services.llm_proxy_service import (
    LLMProxyConfigurationError,
    LLMProxyTokenError,
    create_llm_proxy_token,
    decode_llm_proxy_token,
    proxy_llm_responses,
    resolve_llm_proxy_model_config,
)


@pytest.fixture(autouse=True)
def _reset_llm_proxy_token_key_cache():
    """Reset the global Fernet key cache so each test exercises key resolution."""
    llm_proxy_service._TOKEN_KEY_CACHE = None
    yield
    llm_proxy_service._TOKEN_KEY_CACHE = None


def _model_kind(user_id: int, name: str = "deepseek-v4-flash") -> Kind:
    return Kind(
        user_id=user_id,
        kind="Model",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "provider": "openai",
                "modelConfig": {
                    "env": {
                        "model_id": "gpt-4-turbo",
                        "base_url": "https://api.example.com/v1",
                        "api_key": "sk-test-key",
                    }
                },
                "protocol": "openai-responses",
            },
        },
        is_active=True,
    )


@pytest.fixture
def test_model_kind(test_db, test_user: User) -> Kind:
    model = _model_kind(test_user.id)
    test_db.add(model)
    test_db.commit()
    test_db.refresh(model)
    return model


def test_create_and_decode_proxy_token(test_db, test_user: User, test_model_kind: Kind):
    token = create_llm_proxy_token(
        test_db,
        test_user.id,
        "default",
        test_model_kind.name,
    )
    assert isinstance(token, str)
    assert len(token) > 0

    payload = decode_llm_proxy_token(token)
    assert payload["u"] == test_user.id
    assert payload["ns"] == "default"
    assert payload["n"] == test_model_kind.name
    assert payload["exp"] > payload["iat"]


def test_decode_proxy_token_rejects_invalid_token():
    with pytest.raises(LLMProxyTokenError):
        decode_llm_proxy_token("not-a-valid-token")


def test_decode_proxy_token_rejects_tampered_token(
    test_db, test_user: User, test_model_kind: Kind
):
    token = create_llm_proxy_token(
        test_db,
        test_user.id,
        "default",
        test_model_kind.name,
    )
    with pytest.raises(LLMProxyTokenError):
        decode_llm_proxy_token(token + "x")


def test_decode_proxy_token_rejects_expired_token(
    test_db, test_user: User, test_model_kind: Kind
):
    token = create_llm_proxy_token(
        test_db,
        test_user.id,
        "default",
        test_model_kind.name,
        expires_in_seconds=-1,
    )
    with pytest.raises(LLMProxyTokenError):
        decode_llm_proxy_token(token)


def test_create_proxy_token_fails_for_missing_model(test_db, test_user: User):
    with pytest.raises(LLMProxyConfigurationError):
        create_llm_proxy_token(test_db, test_user.id, "default", "missing-model")


def test_resolve_llm_proxy_model_config(
    test_db, test_user: User, test_model_kind: Kind
):
    token = create_llm_proxy_token(
        test_db,
        test_user.id,
        "default",
        test_model_kind.name,
    )
    payload = decode_llm_proxy_token(token)
    config = resolve_llm_proxy_model_config(test_db, payload)

    assert config["model_id"] == "gpt-4-turbo"
    assert config["base_url"] == "https://api.example.com/v1"
    assert config["api_key"] == "sk-test-key"


async def test_proxy_llm_responses_forwards_to_provider(
    test_db, test_user: User, test_model_kind: Kind
):
    token = create_llm_proxy_token(
        test_db,
        test_user.id,
        "default",
        test_model_kind.name,
    )

    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=b'{"model":"gpt-4-turbo","input":"hello"}'
    )
    request_mock.headers = Headers(
        {"content-type": "application/json", "accept": "text/event-stream"}
    )

    upstream_response_mock = MagicMock()
    upstream_response_mock.status_code = 200
    upstream_response_mock.headers = {"content-type": "text/event-stream"}

    async def fake_aiter_raw():
        for chunk in [b"data: ok\n\n"]:
            yield chunk

    upstream_response_mock.aiter_raw = fake_aiter_raw

    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=upstream_response_mock)
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient", return_value=client_mock
    ):
        response = await proxy_llm_responses(token, request_mock, test_db)

    assert response.status_code == 200
    assert response.media_type == "text/event-stream"

    # Consume the stream so the generator's finally block closes the client.
    body = b"".join([chunk async for chunk in response.body_iterator])
    assert body == b"data: ok\n\n"

    sent_request = client_mock.send.call_args[0][0]
    assert sent_request.method == "POST"
    assert str(sent_request.url) == "https://api.example.com/v1/responses"
    assert sent_request.headers["Authorization"] == "Bearer sk-test-key"
    assert sent_request.headers["Content-Type"] == "application/json"
    assert sent_request.headers["Accept"] == "text/event-stream"
    assert b'"model": "gpt-4-turbo"' in sent_request.content
    assert b'"input": "hello"' in sent_request.content

    client_mock.aclose.assert_awaited_once()


def test_build_codex_runtime_model_config_uses_backend_proxy_for_cloud_models(
    test_db, test_user: User, test_model_kind: Kind
):
    config = _build_codex_runtime_model_config(
        test_model_kind.name,
        db=test_db,
        user_id=test_user.id,
        proxy_backend_base_url="https://wegent.example.com/api/runtime-work",
    )

    assert config["model_id"] == "gpt-4-turbo"
    assert config["api_format"] == "responses"
    assert config["protocol"] == "openai-responses"
    assert config["codex_responses_compat_proxy"] is True
    assert "api_key" in config
    assert config["api_key"] != "sk-test-key"
    assert config["base_url"].startswith(
        "https://wegent.example.com/api/runtime-work/llm-responses-proxy/"
    )


def test_build_codex_runtime_model_config_returns_credentials_without_proxy(
    test_db, test_user: User, test_model_kind: Kind
):
    config = _build_codex_runtime_model_config(
        test_model_kind.name,
        db=test_db,
        user_id=test_user.id,
    )

    assert config["model_id"] == "gpt-4-turbo"
    assert config["base_url"] == "https://api.example.com/v1"
    assert config["api_key"] == "sk-test-key"
    assert "codex_responses_compat_proxy" not in config


def test_llm_proxy_token_key_is_persisted_in_system_config(
    test_db, test_user: User, test_model_kind: Kind
):
    from app.models.system_config import SystemConfig

    # No env key and no cached key -> first token creation should persist a key.
    create_llm_proxy_token(
        test_db,
        test_user.id,
        "default",
        test_model_kind.name,
    )

    stored = (
        test_db.query(SystemConfig)
        .filter(SystemConfig.config_key == "llm_proxy_token_key")
        .first()
    )
    assert stored is not None
    assert isinstance((stored.config_value or {}).get("key"), str)
    assert len((stored.config_value or {})["key"]) > 0
