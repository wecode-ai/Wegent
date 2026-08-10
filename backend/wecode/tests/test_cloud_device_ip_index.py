# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the persisted Nevis cloud-device IP index."""

from typing import Any, Dict, Optional

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from wecode.service.cloud_device_ip_index import (
    NEVIS_IP_FIELD,
    NEVIS_IP_OBSERVED_AT_FIELD,
    CloudDeviceIpIndexService,
    normalize_nevis_ip,
)


class FakeNevisClient:
    def __init__(self, responses: Dict[str, Any]):
        self.responses = responses
        self.calls = []

    def is_configured(self) -> bool:
        return True

    async def get_sandbox(self, sandbox_id: str, http_client=None) -> Dict[str, Any]:
        self.calls.append((sandbox_id, http_client))
        response = self.responses[sandbox_id]
        if isinstance(response, Exception):
            raise response
        return response


def _create_cloud_device(
    db: Session,
    *,
    user_id: int,
    device_name: str,
    sandbox_id: str,
    bind_shell: str = "claudecode",
    nevis_ip: Optional[str] = None,
) -> Kind:
    cloud_config = {"sandboxId": sandbox_id}
    if nevis_ip:
        cloud_config[NEVIS_IP_FIELD] = nevis_ip
    device = Kind(
        user_id=user_id,
        kind="Device",
        namespace="default",
        name=device_name,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_name, "namespace": "default"},
            "spec": {
                "deviceId": device_name,
                "deviceType": "cloud",
                "bindShell": bind_shell,
                "cloudConfig": cloud_config,
            },
            "status": {"state": "Available"},
        },
    )
    db.add(device)
    db.commit()
    return device


@pytest.mark.asyncio
async def test_sync_all_persists_authoritative_nevis_ip(test_db: Session):
    device = _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
    )
    client = FakeNevisClient({"sandbox-1": {"details": {"urls": "2001:0db8:0:0::5"}}})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_all(test_db)

    test_db.refresh(device)
    cloud_config = device.json["spec"]["cloudConfig"]
    assert summary.total == 1
    assert summary.persisted == 1
    assert summary.failed == 0
    assert cloud_config[NEVIS_IP_FIELD] == "2001:db8::5"
    assert cloud_config[NEVIS_IP_OBSERVED_AT_FIELD]
    assert client.calls[0][0] == "sandbox-1"
    assert client.calls[0][1] is not None


@pytest.mark.asyncio
async def test_sync_all_queries_shared_sandbox_once_and_skips_openclaw(
    test_db: Session,
):
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-claudecode",
        sandbox_id="sandbox-1",
    )
    _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-openclaw",
        sandbox_id="sandbox-1",
        bind_shell="openclaw",
    )
    client = FakeNevisClient({"sandbox-1": {"details": {"urls": "10.84.30.133"}}})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_all(test_db)

    assert summary.total == 1
    assert summary.persisted == 1
    assert [sandbox_id for sandbox_id, _ in client.calls] == ["sandbox-1"]


@pytest.mark.asyncio
async def test_sync_all_preserves_last_ip_when_nevis_fails(test_db: Session):
    device = _create_cloud_device(
        test_db,
        user_id=7,
        device_name="device-1",
        sandbox_id="sandbox-1",
        nevis_ip="10.84.30.132",
    )
    client = FakeNevisClient({"sandbox-1": RuntimeError("Nevis unavailable")})
    service = CloudDeviceIpIndexService(client=client)

    summary = await service.sync_all(test_db)

    test_db.refresh(device)
    assert summary.persisted == 0
    assert summary.failed == 1
    assert device.json["spec"]["cloudConfig"][NEVIS_IP_FIELD] == "10.84.30.132"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("10.84.30.133", "10.84.30.133"),
        ("2001:0db8:0:0::5", "2001:db8::5"),
        ("not-an-ip", None),
        (None, None),
    ],
)
def test_normalize_nevis_ip(raw: Any, expected: Optional[str]):
    assert normalize_nevis_ip(raw) == expected
