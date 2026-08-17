# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal Chat Storage authentication."""

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def test_internal_chat_rejects_missing_token(test_client: TestClient) -> None:
    response = test_client.get("/api/internal/chat/health")

    assert response.status_code == 401


def test_internal_chat_rejects_invalid_token(test_client: TestClient) -> None:
    response = test_client.get(
        "/api/internal/chat/health",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401


def test_internal_chat_accepts_internal_service_token(
    test_client: TestClient,
) -> None:
    response = test_client.get(
        "/api/internal/chat/health",
        headers={"Authorization": "Bearer test-internal-token"},
    )

    assert response.status_code == 200
