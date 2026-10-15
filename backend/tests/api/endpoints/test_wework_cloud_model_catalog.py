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
from app.models.user import User


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


# MIGRATION-CANDIDATE: retired Python HTTP test; this API is owned by Rust.
# @pytest.mark.parametrize("mode", ["unknown", True, {}, []])
# @pytest.mark.parametrize("model_type", ["public", "user"])
# def test_invalid_mode_preserves_catalog_but_rejects_execution(
#     test_client: TestClient,
#     test_db: Session,
#     test_token: str,
#     test_user: User,
#     cloud_model: Kind,
#     model_type: str,
#     mode: object,
# ) -> None:
#     """An invalid model must not break listing or silently execute in auto mode."""
#     valid_json = deepcopy(cloud_model.json)
#     valid_json["metadata"]["name"] = "other-cloud-model"
#     test_db.add(
#         Kind(
#             user_id=0,
#             kind="Model",
#             name="other-cloud-model",
#             namespace="default",
#             is_active=True,
#             json=valid_json,
#         )
#     )
#     cloud_model.user_id = 0 if model_type == "public" else test_user.id
#     model_json = deepcopy(cloud_model.json)
#     model_json["spec"]["modelConfig"]["codex_request_mode"] = mode
#     cloud_model.json = model_json
#     test_db.commit()
#
#     models = _catalog(test_client, test_token)
#     assert "other-cloud-model" in models
#     model = models[cloud_model.name]
#     assert model["type"] == model_type
#     assert model["resourceUserId"] == cloud_model.user_id
#     assert model["displayName"] == "Wework cloud model"
#     assert model["provider"] == "openai"
#     assert model["modelId"] == "provider-model"
#     assert model["modelGroup"] == "test-group"
#     assert model["contextWindow"] == 96000
#     assert model["maxOutputTokens"] == 4321
#     assert model["modelCapabilities"]["supportsImage"] is True
#     assert model["config"]["reasoning"] == {"effort": "high", "summary": "detailed"}
#     assert model["config"]["native_tool_search"] is False
#     assert "codex_request_mode" not in model["config"]
#     assert not model["config"].get("env")
#     assert "test-provider-key" not in str(models)
#     assert "private-provider-option" not in str(models)
#     test_db.refresh(cloud_model)
#     assert cloud_model.json["spec"]["modelConfig"]["codex_request_mode"] == mode
#
#     with patch("app.services.llm_proxy_service.httpx.AsyncClient") as upstream:
#         response = test_client.post(
#             "/api/runtime-work/llm-responses-proxy/responses",
#             headers={
#                 "Authorization": f"Bearer {test_token}",
#                 "X-Wegent-Model-Type": model_type,
#                 "X-Wegent-Model-Namespace": "default",
#                 "X-Wegent-Model-User-Id": str(cloud_model.user_id),
#             },
#             json={"model": cloud_model.name, "input": "hello", "stream": True},
#         )
#     assert response.status_code == 400, response.text
#     assert "codex_request_mode" in response.json()["detail"]
#     upstream.assert_not_called()


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


# MIGRATION-CANDIDATE: retired Python HTTP test; this API is owned by Rust.
# @pytest.mark.parametrize("mode", ["standard", "passthrough"])
# @pytest.mark.parametrize("batch_result", ["created", "updated"])
# def test_desktop_fixture_updates_public_model_by_batch_identity(
#     test_client: TestClient,
#     test_db: Session,
#     test_token: str,
#     mode: str,
#     batch_result: str,
# ) -> None:
#     """Both batch paths must support the public-model update used by desktop CI."""
#     headers = {"Authorization": f"Bearer {test_token}"}
#     items = [
#         {
#             "name": "desktop-e2e-cloud-responses",
#             "env": {
#                 "model": "openai",
#                 "model_id": "provider-responses-model",
#                 "base_url": "https://provider.example/v1",
#                 "api_key": "test-provider-key",
#                 "thinking_config": {"reasoning": {"summary": "detailed"}},
#             },
#             "is_active": True,
#             "wework_available": True,
#             "protocol": "openai-responses",
#             "api_format": "responses",
#         }
#     ]
#     first = test_client.post("/api/models/batch", headers=headers, json=items)
#     assert first.status_code == 201, first.text
#     seeded = first.json()
#     if batch_result == "updated":
#         second = test_client.post("/api/models/batch", headers=headers, json=items)
#         assert second.status_code == 201, second.text
#         seeded = second.json()
#         assert seeded["updated"][0]["id"] == first.json()["created"][0]["id"]
#     assert seeded["skipped"] == []
#     saved = seeded[batch_result][0]
#
#     updated = test_client.put(
#         f"/api/models/{saved['id']}",
#         headers=headers,
#         json={
#             "config": {
#                 **saved["config"],
#                 "codex_request_mode": mode,
#                 "max_output_tokens": 4321,
#             }
#         },
#     )
#     assert updated.status_code == 200, updated.text
#     stored = test_db.get(Kind, saved["id"])
#     test_db.refresh(stored)
#     assert stored.user_id == 0
#     assert stored.namespace == "default"
#     assert stored.json["spec"]["modelConfig"]["env"] == items[0]["env"]
#     model = _catalog(test_client, test_token)[saved["name"]]
#     assert model["type"] == "public"
#     assert model["resourceUserId"] == 0
#     assert model["modelId"] == items[0]["env"]["model_id"]
#     assert model["config"]["codex_request_mode"] == mode
#     assert model["config"]["reasoning"] == {"summary": "detailed"}
#     assert model["maxOutputTokens"] == 4321
#     assert not model["config"].get("env")
