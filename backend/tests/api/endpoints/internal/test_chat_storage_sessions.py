# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings


@pytest.fixture(autouse=True)
def configure_internal_chat_auth(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")
    test_client.headers["Authorization"] = "Bearer test-internal-token"


def test_internal_chat_sessions_invalid_offset_negative(test_client: TestClient):
    response = test_client.get("/api/internal/chat/sessions?offset=-1&limit=100")
    assert response.status_code == 422
    payload = response.json()
    assert payload["error_code"] == 422
    assert payload["detail"] == "Request parameter validation failed"
    errors = payload["errors"]
    assert any(
        e["loc"] == ["query", "offset"]
        and e["type"] == "greater_than_equal"
        and e["msg"] == "Input should be greater than or equal to 0"
        for e in errors
    )


def test_internal_chat_sessions_invalid_limit_too_large(test_client: TestClient):
    response = test_client.get("/api/internal/chat/sessions?offset=0&limit=1001")
    assert response.status_code == 422
    payload = response.json()
    assert payload["error_code"] == 422
    assert payload["detail"] == "Request parameter validation failed"
    errors = payload["errors"]
    assert any(
        e["loc"] == ["query", "limit"]
        and e["type"] == "less_than_equal"
        and e["msg"] == "Input should be less than or equal to 1000"
        for e in errors
    )


def test_internal_chat_sessions_invalid_limit_zero(test_client: TestClient):
    response = test_client.get("/api/internal/chat/sessions?offset=0&limit=0")
    assert response.status_code == 422
    payload = response.json()
    assert payload["error_code"] == 422
    errors = payload["errors"]
    assert any(
        e["loc"] == ["query", "limit"]
        and e["type"] == "greater_than_equal"
        and e["msg"] == "Input should be greater than or equal to 1"
        for e in errors
    )


def test_internal_chat_sessions_valid_boundary_values(test_client: TestClient):
    response = test_client.get("/api/internal/chat/sessions?offset=0&limit=1000")
    assert response.status_code == 200
    payload = response.json()
    assert "sessions" in payload
    assert isinstance(payload["sessions"], list)
