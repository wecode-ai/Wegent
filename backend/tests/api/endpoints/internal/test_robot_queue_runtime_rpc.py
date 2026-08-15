# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication contract for internal robot runtime RPC dispatch."""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.api.endpoints.internal import robot_queue
from app.core.config import settings


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def _cancel_request() -> dict:
    return {
        "user_id": 41,
        "device_id": "device-1",
        "method": "runtime.tasks.cancel",
        "payload": {"taskId": "runtime-task-1", "deviceId": "device-1"},
        "wait_ack": True,
        "ack_timeout_seconds": 15,
    }


def test_runtime_rpc_router_rejects_missing_internal_token(
    test_client: TestClient,
) -> None:
    response = test_client.post(
        "/api/internal/robot-queue/emit-runtime-rpc",
        json=_cancel_request(),
    )

    assert response.status_code == 401


def test_runtime_rpc_router_accepts_internal_service_token(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        robot_queue.device_service,
        "get_device_online_info",
        AsyncMock(return_value=None),
    )

    response = test_client.post(
        "/api/internal/robot-queue/emit-runtime-rpc",
        headers={"Authorization": "Bearer test-internal-token"},
        json=_cancel_request(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "emitted": False,
        "reason": "device_offline",
    }
