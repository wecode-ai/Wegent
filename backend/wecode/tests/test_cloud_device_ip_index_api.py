# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the internal cloud-device Nevis IP index API."""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from wecode.api import cloud_device_ip_index as cloud_device_ip_index_api
from wecode.service.cloud_device_ip_index import (
    CloudDeviceIpSyncSummary,
    cloud_device_ip_index_service,
)


class FakeRedis:
    """Minimal Redis resource used to verify API dependency cleanup."""

    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


def _patch_sync_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    summary: CloudDeviceIpSyncSummary,
) -> tuple[FakeRedis, AsyncMock]:
    redis_client = FakeRedis()
    sync_missing = AsyncMock(return_value=summary)
    monkeypatch.setattr(
        cloud_device_ip_index_api.Redis,
        "from_url",
        lambda *_args, **_kwargs: redis_client,
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "sync_missing",
        sync_missing,
    )
    return redis_client, sync_missing


def test_sync_missing_nevis_ips_returns_summary(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_db: Session,
    test_admin_token: str,
) -> None:
    redis_client, sync_missing = _patch_sync_dependencies(
        monkeypatch,
        CloudDeviceIpSyncSummary(
            total=3,
            persisted=2,
            missing_ip=1,
            failed=0,
        ),
    )

    response = test_client.post(
        "/api/internal/admin/cloud-device-ip-index/sync",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "total": 3,
        "persisted": 2,
        "missing_ip": 1,
        "failed": 0,
        "skipped": False,
        "skip_reason": None,
    }
    sync_missing.assert_awaited_once_with(test_db, redis_client)
    assert redis_client.closed is True


def test_sync_missing_nevis_ips_reports_concurrent_sync(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_admin_token: str,
) -> None:
    redis_client, sync_missing = _patch_sync_dependencies(
        monkeypatch,
        CloudDeviceIpSyncSummary(
            total=0,
            persisted=0,
            missing_ip=0,
            failed=0,
            skipped=True,
            skip_reason="lock_not_acquired",
        ),
    )

    response = test_client.post(
        "/api/internal/admin/cloud-device-ip-index/sync",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )

    assert response.status_code == 200
    assert response.json()["skipped"] is True
    assert response.json()["skip_reason"] == "lock_not_acquired"
    sync_missing.assert_awaited_once()
    assert redis_client.closed is True


def test_sync_missing_nevis_ips_requires_admin(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_token: str,
) -> None:
    _redis_client, sync_missing = _patch_sync_dependencies(
        monkeypatch,
        CloudDeviceIpSyncSummary(0, 0, 0, 0),
    )

    response = test_client.post(
        "/api/internal/admin/cloud-device-ip-index/sync",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    assert response.status_code == 403
    sync_missing.assert_not_awaited()


def test_sync_missing_nevis_ips_accepts_admin_api_key(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
    test_admin_api_key: tuple[str, object],
) -> None:
    redis_client, sync_missing = _patch_sync_dependencies(
        monkeypatch,
        CloudDeviceIpSyncSummary(0, 0, 0, 0),
    )
    raw_key, _ = test_admin_api_key

    response = test_client.post(
        "/api/internal/admin/cloud-device-ip-index/sync",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    sync_missing.assert_awaited_once()
    assert redis_client.closed is True
