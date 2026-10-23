# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services import model_credential_service

TEMPLATE = "${USER_SCOPED_MODEL_KEY}"


@pytest.fixture(autouse=True)
def isolate_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(model_credential_service, "_model_api_key_resolver", None)
    monkeypatch.setenv("USER_SCOPED_MODEL_KEY", "synthetic-global-key")


def add_model(db: Session, category: str, protocol: str) -> Kind:
    model = Kind(
        user_id=0,
        kind="Model",
        namespace="default",
        name="scoped-model",
        is_active=True,
        json={
            "kind": "Model",
            "metadata": {"name": "scoped-model", "namespace": "default"},
            "spec": {
                "modelType": category,
                "protocol": protocol,
                "isWeworkAvailable": True,
                "modelConfig": {
                    "env": {
                        "model": "claude" if protocol == "claude" else protocol,
                        "model_id": "provider-model",
                        "base_url": "https://provider.example/v1",
                        "api_key": TEMPLATE,
                    }
                },
            },
        },
    )
    db.add(model)
    db.commit()
    return model


def call_gateway(client: TestClient, token: str, model: Kind) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"}
    headers.update(
        {
            "X-Wegent-Model-Type": "public",
            "X-Wegent-Model-Namespace": "default",
            "X-Wegent-Model-User-Id": "0",
        }
    )
    return client.post(
        "/api/runtime-work/llm-responses-proxy/chat/completions",
        headers=headers,
        json={"model": model.name, "input": "Hello"},
    )


def mock_provider(
    monkeypatch: pytest.MonkeyPatch, protocol: str
) -> list[httpx.Request]:
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            stream=httpx.ByteStream(b"data: ok\n\n"),
            headers={"content-type": "text/event-stream"},
        )

    async_client, sync_client = httpx.AsyncClient, httpx.Client
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: async_client(transport=httpx.MockTransport(respond), **kwargs),
    )
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: sync_client(transport=httpx.MockTransport(respond), **kwargs),
    )
    return requests


@pytest.mark.parametrize(
    ("category", "protocol"),
    [
        ("llm", "openai-responses"),
        ("llm", "openai"),
        ("llm", "claude"),
    ],
)
def test_gateways_use_request_user_keys_without_persisting_them(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    test_token: str,
    test_admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
    category: str,
    protocol: str,
) -> None:
    model = add_model(test_db, category, protocol)
    requests = mock_provider(monkeypatch, protocol)

    async def lookup(template: str, user: User) -> str:
        assert template == TEMPLATE
        return f"synthetic-user-key-{user.id}"

    resolver = AsyncMock(side_effect=lookup)
    model_credential_service.register_model_api_key_resolver(resolver)
    for token in (test_token, test_admin_token):
        response = call_gateway(test_client, token, model)
        assert response.status_code == 200, response.text
        assert "synthetic-user-key" not in response.text
    header = "x-api-key" if protocol == "claude" else "authorization"
    prefix = "" if protocol == "claude" else "Bearer "
    assert [request.headers[header] for request in requests] == [
        f"{prefix}synthetic-user-key-{test_user.id}",
        f"{prefix}synthetic-user-key-{test_admin_user.id}",
    ]
    assert [call.args[1].id for call in resolver.await_args_list] == [
        test_user.id,
        test_admin_user.id,
    ]
    assert model.json["spec"]["modelConfig"]["env"]["api_key"] == TEMPLATE


@pytest.mark.parametrize("failure", ["exception", "empty"])
def test_credential_failure_blocks_transport_and_environment_fallback(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    model = add_model(test_db, "llm", "openai")
    resolver = (
        AsyncMock(side_effect=RuntimeError("private-lookup-details"))
        if failure == "exception"
        else AsyncMock(return_value="")
    )
    model_credential_service.register_model_api_key_resolver(resolver)
    async_factory, sync_factory = MagicMock(), MagicMock()
    monkeypatch.setattr(httpx, "AsyncClient", async_factory)
    monkeypatch.setattr(httpx, "Client", sync_factory)
    response = call_gateway(test_client, test_token, model)
    assert response.status_code == 503, response.text
    assert "private-lookup-details" not in response.text
    assert "synthetic-global-key" not in response.text
    async_factory.assert_not_called()
    sync_factory.assert_not_called()


@pytest.mark.parametrize("api_key", [TEMPLATE, "${SECRET_KEY}", "key\r\ninjected"])
def test_connection_cannot_resolve_submitted_keys_to_caller_controlled_endpoints(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    api_key: str,
) -> None:
    resolver = AsyncMock(return_value="synthetic-user-secret")
    model_credential_service.register_model_api_key_resolver(resolver)
    probe = MagicMock(return_value={"success": True, "message": "Connected"})
    monkeypatch.setattr("app.api.endpoints.adapter.models._test_llm_connection", probe)

    response = test_client.post(
        "/api/models/test-connection",
        headers={"Authorization": f"Bearer {test_token}"},
        json={
            "provider_type": "systemone",
            "model_category_type": "decision",
            "model_id": "provider-model",
            "api_key": api_key,
            "base_url": "https://caller-controlled.example/v1",
        },
    )

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert "synthetic-user-secret" not in response.text
    resolver.assert_not_awaited()
    probe.assert_not_called()


def test_connection_uses_only_the_submitted_literal_key(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolver = AsyncMock(return_value="synthetic-user-secret")
    model_credential_service.register_model_api_key_resolver(resolver)
    probe = MagicMock(return_value={"success": True, "message": "Connected"})
    monkeypatch.setattr("app.api.endpoints.adapter.models._test_llm_connection", probe)

    response = test_client.post(
        "/api/models/test-connection",
        headers={"Authorization": f"Bearer {test_token}"},
        json={
            "provider_type": "systemone",
            "model_id": "provider-model",
            "api_key": "  submitted-literal-key  ",
            "base_url": "https://caller-controlled.example/v1",
        },
    )

    assert response.json()["success"] is True
    resolver.assert_not_awaited()
    assert probe.call_args.kwargs["api_key"] == "submitted-literal-key"
