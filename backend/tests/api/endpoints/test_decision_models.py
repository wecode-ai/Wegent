# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from copy import deepcopy
from typing import Callable
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind
from app.models.user import User
from app.services.capability_reference_service import ensure_capability_reference
from shared.utils.crypto import encrypt_api_key


@pytest.fixture
def decision_model(test_db: Session) -> Kind:
    model = Kind(
        name="decision-model",
        user_id=0,
        kind="Model",
        namespace="default",
        is_active=True,
        json={
            "kind": "Model",
            "metadata": {
                "name": "decision-model",
                "namespace": "default",
                "displayName": "Decision model",
            },
            "spec": {
                "modelType": "decision",
                "protocol": "systemone",
                "isWeworkAvailable": True,
                "modelConfig": {
                    "env": {
                        "model": "systemone",
                        "model_id": "provider-model",
                        "base_url": "https://decision.example/v1",
                        "api_key": "private-provider-key",
                        "custom_headers": {"x-tenant": "${user.user_name}"},
                    }
                },
            },
        },
    )
    test_db.add(model)
    test_db.commit()
    return model


def catalog(client: TestClient, token: str) -> dict:
    response = client.get(
        "/api/models/decisions", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def execute(client: TestClient, token: str, model: str) -> httpx.Response:
    return client.post(
        "/api/models/decisions",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "model": model,
            "state": {"comment": "urgent"},
            "questions": {"urgent": {"type": "noul", "instructions": "Is it urgent?"}},
        },
    )


def fake_provider(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.services.decision_model_service.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )


def test_catalog_is_authorized_safe_and_does_not_expose_provider_config(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    decision_model: Kind,
) -> None:
    body = catalog(test_client, test_token)
    assert body["models"][0]["protocol"] == "systemone"
    assert body["models"][0]["modelId"] == "provider-model"
    assert body["defaultModel"] == body["models"][0]["id"]
    assert len(body["defaultModel"]) == 64
    for private in ["private-provider-key", "decision.example", "custom_headers"]:
        assert private not in str(body)
    assert test_client.get("/api/models/decisions").status_code == 401
    test_db.add(
        Kind(
            name="Agno",
            namespace="default",
            user_id=0,
            kind="Shell",
            is_active=True,
            json={
                "kind": "Shell",
                "metadata": {"name": "Agno"},
                "spec": {"shellType": "Agno", "supportModel": ["openai", "systemone"]},
            },
        )
    )
    test_db.commit()
    shell_models = test_client.get(
        "/api/models/unified",
        params={"shell_type": "Agno"},
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert shell_models.status_code == 200, shell_models.text
    assert all(
        model["name"] != decision_model.name for model in shell_models.json()["data"]
    )


@pytest.mark.parametrize(
    "change", ["inactive", "hidden", "wework_disabled", "whitelist", "other_user"]
)
def test_removed_or_unauthorized_model_disappears_and_cannot_execute(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    decision_model: Kind,
    change: str,
) -> None:
    model_id = catalog(test_client, test_token)["defaultModel"]
    value = deepcopy(decision_model.json)
    if change == "inactive":
        decision_model.is_active = False
    elif change == "hidden":
        value["spec"]["isVisible"] = False
    elif change == "wework_disabled":
        value["spec"]["isWeworkAvailable"] = False
    elif change == "whitelist":
        value["spec"].update({"allowedUsersEnabled": True, "allowedUsers": []})
    else:
        decision_model.user_id = 987654
    decision_model.json = value
    test_db.commit()
    assert catalog(test_client, test_token)["models"] == []
    with patch("app.services.decision_model_service.httpx.AsyncClient") as provider:
        response = execute(test_client, test_token, model_id)
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "model_not_found"
    provider.assert_not_called()


@pytest.mark.parametrize("protocol", ["systemone", "openai"])
def test_selected_model_uses_latest_config_and_declared_protocol(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    decision_model: Kind,
    protocol: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_id = catalog(test_client, test_token)["defaultModel"]
    value = deepcopy(decision_model.json)
    value["spec"]["protocol"] = protocol
    value["spec"]["modelConfig"]["env"].update(
        {
            "model": protocol,
            "model_id": "updated-provider-model",
            "api_key": encrypt_api_key("updated-private-key"),
        }
    )
    decision_model.json = value
    test_db.commit()
    recorded = []

    def provider(request: httpx.Request) -> httpx.Response:
        recorded.append(request)
        assert (
            request.url.path
            == f"/v1/{'systemone' if protocol == 'systemone' else 'decisions'}"
        )
        assert request.headers["authorization"] == "Bearer updated-private-key"
        assert request.headers["x-tenant"] == test_user.user_name
        payload = json.loads(request.content)
        assert payload["model"] == "updated-provider-model"
        if protocol == "systemone":
            assert payload["state"] == {"comment": "urgent"}
            answers = {"urgent": {"type": "noul", "noul": 0.9, "debug": "private"}}
        else:
            assert payload["input"] == '{"comment": "urgent"}'
            assert payload["questions"][0]["type"] == "predicate"
            answers = [{"name": "urgent", "type": "predicate", "probability": 0.9}]
        return httpx.Response(200, json={"answers": answers, "debug": "private"})

    fake_provider(monkeypatch, provider)
    response = execute(test_client, test_token, model_id)
    assert response.status_code == 200, response.text
    assert response.json()["answers"]["urgent"] == {"type": "noul", "noul": 0.9}
    assert response.json()["model"] == model_id
    assert "private" not in response.text
    assert len(recorded) == 1


def test_personal_and_public_models_with_same_name_have_distinct_ids(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    decision_model: Kind,
) -> None:
    personal = Kind(
        name=decision_model.name,
        namespace="default",
        user_id=test_user.id,
        kind="Model",
        is_active=True,
        json=deepcopy(decision_model.json),
    )
    test_db.add(personal)
    test_db.commit()
    models = catalog(test_client, test_token)["models"]
    assert len(models) == 2
    assert len({model["id"] for model in models}) == 2
    assert {model["type"] for model in models} == {"public", "user"}


@pytest.mark.parametrize(
    ("status", "expected", "code"),
    [
        (401, 502, "upstream_rejected"),
        (429, 429, "upstream_rate_limited"),
        (529, 502, "upstream_rejected"),
        (200, 502, "upstream_invalid_response"),
    ],
)
def test_provider_failures_are_sanitized_without_retry(
    test_client: TestClient,
    test_token: str,
    decision_model: Kind,
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    expected: int,
    code: str,
) -> None:
    calls = []

    def provider(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json={"message": "private-provider-key"})

    fake_provider(monkeypatch, provider)
    response = execute(
        test_client, test_token, catalog(test_client, test_token)["defaultModel"]
    )
    assert response.status_code == expected, response.text
    assert response.json()["error"]["code"] == code
    assert "private-provider-key" not in response.text
    assert len(calls) == 1


def test_invalid_request_and_timeout_have_static_errors(
    test_client: TestClient,
    test_token: str,
    decision_model: Kind,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_id = catalog(test_client, test_token)["defaultModel"]
    response = test_client.post(
        "/api/models/decisions",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"model": model_id, "state": "text", "questions": {}, "apiKey": "private"},
    )
    assert response.status_code == 400
    assert "private" not in response.text

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("private-provider-key")

    fake_provider(monkeypatch, timeout)
    response = execute(test_client, test_token, model_id)
    assert response.status_code == 504
    assert response.json()["error"]["retryable"] is True
    assert "private-provider-key" not in response.text


@pytest.mark.parametrize("owner", ["public", "user"])
def test_existing_management_crud_supports_decision_models(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_admin_token: str,
    decision_model: Kind,
    owner: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_factory = sessionmaker(
        bind=test_db.get_bind(),
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    monkeypatch.setattr("app.services.kind_base.SessionLocal", session_factory)
    monkeypatch.setattr("app.db.session.SessionLocal", session_factory)
    value = deepcopy(decision_model.json)
    value["metadata"]["name"] = "managed-decision"
    value["metadata"]["displayName"] = "Managed decision"
    token = test_admin_token if owner == "public" else test_token
    headers = {"Authorization": f"Bearer {token}"}
    path = (
        "/api/admin/public-models"
        if owner == "public"
        else "/api/v1/namespaces/default/models"
    )
    body = {"name": "managed-decision", "json": value} if owner == "public" else value
    created = test_client.post(path, headers=headers, json=body)
    assert created.status_code == 201, created.text
    detail_path = (
        f"{path}/{created.json()['id']}"
        if owner == "public"
        else f"{path}/managed-decision"
    )
    initial = next(
        model
        for model in catalog(test_client, test_token)["models"]
        if model["displayName"] == value["metadata"]["displayName"]
        and model["type"] == owner
    )
    value["spec"]["protocol"] = "openai"
    value["spec"]["modelConfig"]["env"].update(
        {"model": "openai", "model_id": "changed-model"}
    )
    body = {"json": value} if owner == "public" else value
    updated = test_client.put(detail_path, headers=headers, json=body)
    assert updated.status_code == 200, updated.text
    refreshed = next(
        model
        for model in catalog(test_client, test_token)["models"]
        if model["id"] == initial["id"]
    )
    assert refreshed["protocol"] == "openai"
    assert refreshed["modelId"] == "changed-model"
    deleted = test_client.delete(detail_path, headers=headers)
    assert deleted.status_code in {200, 204}, deleted.text
    assert all(
        model["id"] != initial["id"]
        for model in catalog(test_client, test_token)["models"]
    )


def test_shared_model_reference_is_usable_only_while_authorized(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    test_admin_user: User,
    decision_model: Kind,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision_model.user_id = test_admin_user.id
    decision_model.namespace = "source-space"
    test_db.commit()
    reference, _ = ensure_capability_reference(
        test_db, source=decision_model, target_namespace="default", user_id=test_user.id
    )
    test_db.commit()
    model_id = catalog(test_client, test_token)["defaultModel"]
    assert model_id
    fake_provider(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"answers": {"urgent": {"type": "noul", "noul": 0.9}}}
        ),
    )
    assert execute(test_client, test_token, model_id).status_code == 200
    test_db.delete(reference)
    test_db.commit()
    assert catalog(test_client, test_token)["models"] == []
    assert execute(test_client, test_token, model_id).status_code == 404
