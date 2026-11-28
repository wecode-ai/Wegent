# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authentication contract for mutating shutdown control endpoints."""

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


@pytest.mark.parametrize(
    "path",
    ["/api/shutdown/initiate", "/api/shutdown/wait", "/api/shutdown/reset"],
)
def test_shutdown_mutations_reject_missing_token(
    path: str, test_client: TestClient
) -> None:
    response = test_client.post(path)

    assert response.status_code == 401


def test_shutdown_status_remains_public(test_client: TestClient) -> None:
    response = test_client.get("/api/shutdown/status")

    assert response.status_code in {200, 503}


def test_shutdown_wait_rejects_invalid_token(test_client: TestClient) -> None:
    response = test_client.post(
        "/api/shutdown/wait",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401
