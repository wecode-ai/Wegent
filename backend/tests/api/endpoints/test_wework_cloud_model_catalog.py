# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regressions for Wework model catalogs, gateway validation and CI fixtures."""

from copy import deepcopy
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.kind import Kind


@pytest.fixture(autouse=True)
def isolate_crd_sessions(test_db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    """Bind CRD-owned sessions to the same real SQLite transaction as the API."""
    monkeypatch.setattr(
        "app.services.kind_base.SessionLocal",
        sessionmaker(bind=test_db.get_bind(), expire_on_commit=False),
    )


@pytest.fixture
def cloud_model(test_db: Session) -> Kind:
    """Persist a visible public model with provider credentials and metadata."""
    model = Kind(
        user_id=0,
        kind="Model",
        name="wework-cloud-model",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "wework-cloud-model",
                "namespace": "default",
                "displayName": "Wework cloud model",
            },
            "spec": {
                "protocol": "openai-responses",
                "apiFormat": "responses",
                "isWeworkAvailable": True,
                "modelGroup": "test-group",
                "modelCapabilities": {"supportsImage": True},
                "modelConfig": {
                    "context_window": 96000,
                    "max_output_tokens": 4321,
                    "native_tool_search": False,
                    "env": {
                        "model": "openai",
                        "model_id": "provider-model",
                        "base_url": "https://provider.example/v1",
                        "api_key": "test-provider-key",
                        "thinking_config": {
                            "reasoning": {"effort": "high", "summary": "detailed"},
                            "secret": "private-provider-option",
                        },
                    },
                },
            },
        },
    )
    test_db.add(model)
    test_db.commit()
    return model


def _catalog(test_client: TestClient, token: str) -> dict[str, dict]:
    """Read the real unified catalog through authentication and CRD adapters."""
    response = test_client.get(
        "/api/models/unified",
        params={"include_config": True, "scope": "all", "client_origin": "wework"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    return {model["name"]: model for model in response.json()["data"]}


@pytest.mark.parametrize(
    ("protocol", "api_format"),
    [("openai", "chat/completions"), ("anthropic-messages", None)],
)
def test_gateway_rejects_passthrough_for_non_responses_models(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    cloud_model: Kind,
    protocol: str,
    api_format: str | None,
) -> None:
    """Local-device requests must validate the authoritative upstream protocol."""
    model_json = deepcopy(cloud_model.json)
    model_json["spec"].update({"protocol": protocol, "apiFormat": api_format})
    model_json["spec"]["modelConfig"]["codex_request_mode"] = "passthrough"
    cloud_model.json = model_json
    test_db.commit()

    with patch("app.services.llm_proxy_service.httpx.AsyncClient") as upstream:
        response = test_client.post(
            "/api/runtime-work/llm-responses-proxy/responses",
            headers={
                "Authorization": f"Bearer {test_token}",
                "X-Wegent-Model-Type": "public",
                "X-Wegent-Model-Namespace": "default",
                "X-Wegent-Model-User-Id": "0",
            },
            json={"model": cloud_model.name, "input": "hello", "stream": True},
        )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == (
        "Codex passthrough requires an OpenAI Responses model"
    )
    upstream.assert_not_called()


@pytest.fixture
def test_client(test_client):
    """Exercise retained Python HTTP components in an isolated application."""
    from tests.retained_python_handlers import component_client

    with component_client(test_client, ("llm_responses",)) as client:
        yield client
