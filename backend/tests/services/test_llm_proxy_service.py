# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException, Request
from starlette.datastructures import Headers

from app.models.kind import Kind
from app.models.user import User
from app.services.chat.trigger.unified import _build_codex_runtime_model_config
from app.services.llm_proxy_service import (
    proxy_llm_responses,
    resolve_llm_proxy_model_config,
)


def _model_kind(
    user_id: int,
    *,
    name: str = "deepseek-v4-flash",
    namespace: str = "default",
    model_id: str = "gpt-4-turbo",
    api_key: str = "sk-test-key",
    base_url: str = "https://api.example.com/v1",
    protocol: str = "openai-responses",
    default_headers: dict[str, str] | None = None,
) -> Kind:
    model_config: dict[str, object] = {
        "env": {
            "model_id": model_id,
            "base_url": base_url,
            "api_key": api_key,
        }
    }
    if default_headers is not None:
        model_config["DEFAULT_HEADERS"] = default_headers

    return Kind(
        user_id=user_id,
        kind="Model",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "provider": "openai",
                "modelConfig": model_config,
                "protocol": protocol,
            },
        },
        is_active=True,
    )


@pytest.fixture
def test_model_kind(test_db, test_user: User) -> Kind:
    model = _model_kind(
        test_user.id,
        default_headers={"user": "${task_data.user.name}"},
    )
    test_db.add(model)
    test_db.commit()
    test_db.refresh(model)
    return model


def test_resolve_llm_proxy_model_config_uses_complete_identity(
    test_db, test_user: User, test_model_kind: Kind
):
    public_model = _model_kind(
        0,
        name=test_model_kind.name,
        model_id="public-provider-model",
    )
    test_db.add(public_model)
    test_db.commit()

    personal_config = resolve_llm_proxy_model_config(
        test_db,
        test_user,
        model_name=test_model_kind.name,
        model_type="user",
        namespace="default",
        resource_user_id=test_user.id,
    )
    public_config = resolve_llm_proxy_model_config(
        test_db,
        test_user,
        model_name=public_model.name,
        model_type="public",
        namespace="default",
        resource_user_id=0,
    )

    assert personal_config["model_id"] == "gpt-4-turbo"
    assert public_config["model_id"] == "public-provider-model"


def test_resolve_llm_proxy_model_config_rejects_spoofed_personal_owner(
    test_db, test_user: User
):
    with pytest.raises(HTTPException) as exc_info:
        resolve_llm_proxy_model_config(
            test_db,
            test_user,
            model_name="private-model",
            model_type="user",
            namespace="default",
            resource_user_id=test_user.id + 1,
        )

    assert exc_info.value.status_code == 403


def test_resolve_llm_proxy_model_config_processes_custom_header_placeholders(
    test_db, test_user: User
):
    model = _model_kind(
        test_user.id,
        name="custom-header-model",
        default_headers={
            "user": "${task_data.user.name}",
            "x-custom-static": "static-value",
            "wegent-agent-name": "${task_data.team.name}",
        },
    )
    test_db.add(model)
    test_db.commit()

    config = resolve_llm_proxy_model_config(
        test_db,
        test_user,
        model_name=model.name,
        model_type="user",
        namespace="default",
        resource_user_id=test_user.id,
    )

    assert config["default_headers"] == {
        "user": test_user.user_name,
        "x-custom-static": "static-value",
    }


async def test_proxy_llm_responses_forwards_to_provider(
    test_db, test_user: User, test_model_kind: Kind
):
    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=b'{"model":"deepseek-v4-flash","input":"hello"}'
    )
    request_mock.headers = Headers(
        {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(test_user.id),
        }
    )

    upstream_response_mock = MagicMock()
    upstream_response_mock.status_code = 200
    upstream_response_mock.headers = {"content-type": "text/event-stream"}

    async def fake_aiter_raw():
        yield b"data: ok\n\n"

    upstream_response_mock.aiter_raw = fake_aiter_raw
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=upstream_response_mock)
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 200
    assert response.media_type == "text/event-stream"
    body = b"".join([chunk async for chunk in response.body_iterator])
    assert body == b"data: ok\n\n"

    sent_request = client_mock.send.call_args[0][0]
    assert str(sent_request.url) == "https://api.example.com/v1/responses"
    assert sent_request.headers["Authorization"] == "Bearer sk-test-key"
    assert sent_request.headers["Content-Type"] == "application/json"
    assert sent_request.headers["Accept"] == "text/event-stream"
    assert sent_request.headers["user"] == test_user.user_name
    assert b'"model": "gpt-4-turbo"' in sent_request.content
    assert b'"input": "hello"' in sent_request.content
    assert "x-wegent-model-type" not in sent_request.headers
    client_mock.aclose.assert_awaited_once()


async def test_proxy_llm_responses_omits_authorization_when_api_key_is_empty(
    test_db, test_user: User
):
    model = _model_kind(
        test_user.id,
        name="custom-header-auth-model",
        api_key="",
        default_headers={
            "wecode-user": "${task_data.user.name}",
            "Wecode-Executor": "chat",
            "wecode-action": "wegent",
        },
    )
    test_db.add(model)
    test_db.commit()

    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=b'{"model":"custom-header-auth-model","input":"hello"}'
    )
    request_mock.headers = Headers(
        {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(test_user.id),
            "authorization": "Bearer wegent-login-token",
            "x-wegent-upstream-header-wecode-executor": "codex",
            "x-wegent-upstream-header-wecode-action": "custom-action",
        }
    )

    upstream_response_mock = MagicMock()
    upstream_response_mock.status_code = 200
    upstream_response_mock.headers = {"content-type": "text/event-stream"}

    async def fake_aiter_raw():
        yield b"data: ok\n\n"

    upstream_response_mock.aiter_raw = fake_aiter_raw
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=upstream_response_mock)
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    body = b"".join([chunk async for chunk in response.body_iterator])
    sent_request = client_mock.send.call_args[0][0]

    assert response.status_code == 200
    assert body == b"data: ok\n\n"
    assert "Authorization" not in sent_request.headers
    assert sent_request.headers["wecode-user"] == test_user.user_name
    assert sent_request.headers["wecode-executor"] == "codex"
    assert sent_request.headers["wecode-action"] == "custom-action"
    assert (
        sum(name == "wecode-executor" for name, _ in sent_request.headers.multi_items())
        == 1
    )
    client_mock.aclose.assert_awaited_once()


async def test_proxy_llm_responses_rejects_protected_custom_upstream_header(
    test_db, test_user: User, test_model_kind: Kind
):
    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=b'{"model":"deepseek-v4-flash","input":"hello"}'
    )
    request_mock.headers = Headers(
        {
            "content-type": "application/json",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(test_user.id),
            "x-wegent-upstream-header-authorization": "Bearer caller-token",
        }
    )

    with pytest.raises(HTTPException) as exc_info:
        await proxy_llm_responses(request_mock, test_db, test_user)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Custom upstream header is protected: authorization"


async def test_proxy_llm_responses_requires_model_identity_headers(
    test_db, test_user: User
):
    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(return_value=b'{"model":"model-1","input":"hello"}')
    request_mock.headers = Headers({"content-type": "application/json"})

    with pytest.raises(HTTPException) as exc_info:
        await proxy_llm_responses(request_mock, test_db, test_user)

    assert exc_info.value.status_code == 400


def test_build_codex_runtime_model_config_returns_provider_credentials(
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


async def test_proxy_llm_responses_forwards_chat_completions_to_provider(
    test_db, test_user: User
):
    model = _model_kind(
        test_user.id,
        name="chat-completions-model",
        protocol="openai",
        api_key="sk-chat-key",
    )
    test_db.add(model)
    test_db.commit()

    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=b'{"model":"chat-completions-model","input":"hello"}'
    )
    request_mock.headers = Headers(
        {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(test_user.id),
        }
    )

    upstream_response_mock = MagicMock()
    upstream_response_mock.status_code = 200
    upstream_response_mock.headers = {"content-type": "text/event-stream"}

    async def fake_aiter_raw():
        yield b"data: ok\n\n"

    upstream_response_mock.aiter_raw = fake_aiter_raw
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=upstream_response_mock)
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 200
    sent_request = client_mock.send.call_args[0][0]
    assert str(sent_request.url) == "https://api.example.com/v1/chat/completions"
    assert sent_request.headers["Authorization"] == "Bearer sk-chat-key"
    assert b'"model": "gpt-4-turbo"' in sent_request.content


async def test_proxy_llm_responses_forwards_anthropic_messages_to_provider(
    test_db, test_user: User
):
    model = _model_kind(
        test_user.id,
        name="anthropic-model",
        protocol="claude",
        api_key="sk-anthropic-key",
        base_url="https://api.anthropic.com",
    )
    test_db.add(model)
    test_db.commit()

    request_mock = MagicMock(spec=Request)
    request_mock.body = AsyncMock(
        return_value=b'{"model":"anthropic-model","input":"hello"}'
    )
    request_mock.headers = Headers(
        {
            "content-type": "application/json",
            "accept": "text/event-stream",
            "x-wegent-model-type": "user",
            "x-wegent-model-namespace": "default",
            "x-wegent-model-user-id": str(test_user.id),
        }
    )

    upstream_response_mock = MagicMock()
    upstream_response_mock.status_code = 200
    upstream_response_mock.headers = {"content-type": "text/event-stream"}

    async def fake_aiter_raw():
        yield b"data: ok\n\n"

    upstream_response_mock.aiter_raw = fake_aiter_raw
    client_mock = AsyncMock()
    client_mock.send = AsyncMock(return_value=upstream_response_mock)
    client_mock.aclose = AsyncMock()

    with patch(
        "app.services.llm_proxy_service.httpx.AsyncClient",
        return_value=client_mock,
    ):
        response = await proxy_llm_responses(request_mock, test_db, test_user)

    assert response.status_code == 200
    sent_request = client_mock.send.call_args[0][0]
    assert str(sent_request.url) == "https://api.anthropic.com/v1/messages"
    assert sent_request.headers["x-api-key"] == "sk-anthropic-key"
    assert sent_request.headers["anthropic-version"] == "2023-06-01"
    assert "Authorization" not in sent_request.headers
