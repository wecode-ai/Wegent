# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication contract for retained robot queue device diagnostics."""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.api.endpoints.internal import robot_queue
from app.core.config import settings


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def test_device_status_router_rejects_missing_internal_token(
    test_client: TestClient,
) -> None:
    response = test_client.get(
        "/api/internal/robot-queue/device-status",
        params={"user_id": 41, "device_id": "device-1"},
    )

    assert response.status_code == 401


def test_device_status_router_accepts_internal_service_token(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        robot_queue.device_service,
        "get_device_online_info",
        AsyncMock(return_value=None),
    )

    response = test_client.get(
        "/api/internal/robot-queue/device-status",
        headers={"Authorization": "Bearer test-internal-token"},
        params={"user_id": 41, "device_id": "device-1"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "user_id": 41,
        "device_id": "device-1",
        "online": False,
    }
